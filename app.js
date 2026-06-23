/* ==========================================================================
   AirShare — peer-to-peer file transfer over WebRTC (via PeerJS signaling)

   How this works, briefly:
   - PeerJS gives us a free public "signaling" server just to introduce two
     browsers to each other (exchange connection info). Once connected, the
     actual file data flows directly device-to-device over a WebRTC
     DataChannel — it does NOT pass through any server.
   - Files are sent in chunks so we can show progress and not blow up memory
     on large files. The receiver reassembles chunks into a Blob and offers
     a download.
   - A 6-digit room code IS the peer ID (namespaced) so it's short enough to
     read aloud or type on another device.
   ========================================================================== */

(() => {
  'use strict';

  // ---- Tunables ----------------------------------------------------------
  const CHUNK_SIZE = 64 * 1024;        // 64KB per chunk over the data channel
  const ROOM_PREFIX = 'airshare-';      // namespaces our peer IDs on the public broker
  const MAX_BUFFERED = 4 * 1024 * 1024; // pause sending if channel buffer exceeds this (backpressure)

  // ---- State --------------------------------------------------------------
  let peer = null;
  let conn = null;
  let isHost = false;
  const outgoingQueue = [];
  let sending = false;

  // ---- DOM refs -------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const stages = {
    idle: $('stage-idle'),
    waiting: $('stage-waiting'),
    connected: $('stage-connected'),
  };
  const connectionBadge = $('connectionBadge');
  const roomCodeDisplay = $('roomCodeDisplay');
  const waitingStatus = $('waitingStatus');
  const pulseStage = $('pulseStage');
  const peerIdShort = $('peerIdShort');
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const transferList = $('transferList');
  const toastStack = $('toastStack');
  const joinError = $('joinError');
  const qrCanvasHost = $('qrCanvasHost');
  const btnScanQr = $('btnScanQr');
  const qrScanModal = $('qrScanModal');
  const qrReaderEl = $('qrReader');
  const btnCloseScan = $('btnCloseScan');

  function showStage(name) {
    Object.entries(stages).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
  }

  function setBadge(state, text) {
    connectionBadge.dataset.state = state;
    connectionBadge.querySelector('.status-text').textContent = text;
  }

  function toast(message, isError = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function genCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  // ==========================================================================
  // QR code: generate (host side) + scan (joiner side)
  // ==========================================================================

  function renderRoomQr(code) {
    qrCanvasHost.innerHTML = '';
    if (typeof QRCode === 'undefined') {
      // library failed to load (e.g. CDN blocked) — degrade gracefully,
      // the 6-digit code still works on its own.
      qrCanvasHost.hidden = true;
      return;
    }
    qrCanvasHost.hidden = false;
    new QRCode(qrCanvasHost, {
      text: code,
      width: 152,
      height: 152,
      colorDark: '#0a0e17',
      colorLight: '#e8ecf4',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  let html5QrScanner = null;

  function openScanner() {
    if (typeof Html5Qrcode === 'undefined') {
      toast('Scanner library failed to load — enter the code manually instead.', true);
      return;
    }
    qrScanModal.hidden = false;
    html5QrScanner = new Html5Qrcode('qrReader');

    const config = { fps: 10, qrbox: 220 };
    const onSuccess = (decodedText) => {
      const digits = (decodedText.match(/\d/g) || []).join('').slice(0, 6);
      if (digits.length === 6) {
        closeScanner();
        $('joinCode').value = digits;
        $('btnJoin').classList.add('is-valid');
        joinRoom(digits);
      }
    };
    const onScanFailure = () => { /* per-frame scan miss — expected constantly while aiming, ignore */ };

    // Prefer the rear camera (typical on phones), but laptops/desktops often
    // have no camera matching "environment" at all, which throws immediately.
    // Fall back to whatever camera is available rather than failing outright.
    html5QrScanner
      .start({ facingMode: 'environment' }, config, onSuccess, onScanFailure)
      .catch((err) => {
        console.warn('environment-facing camera unavailable, trying default camera:', err);
        return html5QrScanner.start(true, config, onSuccess, onScanFailure);
      })
      .catch((err) => {
        console.error('Camera start failed:', err);
        toast('Could not access camera — check permissions, or enter the code manually.', true);
        closeScanner();
      });
  }

  function closeScanner() {
    qrScanModal.hidden = true;
    if (html5QrScanner) {
      html5QrScanner.stop().catch(() => {}).finally(() => {
        html5QrScanner.clear();
        html5QrScanner = null;
      });
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================

  function createRoom() {
    const code = genCode();
    isHost = true;
    setBadge('waiting', 'Waiting…');
    showStage('waiting');
    waitingStatus.textContent = 'Starting room…';
    waitingStatus.classList.remove('found');
    pulseStage.classList.remove('found');
    roomCodeDisplay.textContent = code.split('').join(' '); // set immediately, before Peer() can throw
    renderRoomQr(code);

    try {
      peer = new Peer(ROOM_PREFIX + code, { debug: 0 });
    } catch (e) {
      console.error('Failed to create Peer:', e);
      toast('Could not start a room — try reloading the page.', true);
      return;
    }

    peer.on('open', () => {
      waitingStatus.textContent = 'Listening for connection…';
    });

    peer.on('connection', (incomingConn) => {
      conn = incomingConn;
      wireConnection();
    });

    // The signaling socket to the broker can drop on its own — mobile devices
    // sleeping the tab, brief broker hiccups, etc. Without handling this, the
    // room looks alive ("Listening…") forever while actually being dead.
    peer.on('disconnected', () => {
      waitingStatus.textContent = 'Connection lost — reconnecting…';
      waitingStatus.classList.remove('found');
      // peer.reconnect() re-establishes the signaling socket using the same ID,
      // so the room code stays valid for anyone trying to join.
      if (peer && !peer.destroyed) {
        try { peer.reconnect(); } catch (e) { /* will retry via error handler below */ }
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'unavailable-id') {
        // extremely rare collision — just retry with a new code
        peer.destroy();
        createRoom();
      } else if (err.type === 'network' || err.type === 'server-error') {
        waitingStatus.textContent = 'Network issue — retrying…';
        setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 1500);
      } else {
        toast('Connection error: ' + err.type, true);
      }
    });
  }

  function joinRoom(code) {
    joinError.hidden = true;

    try {
      peer = new Peer({ debug: 0 });
    } catch (e) {
      console.error('Failed to create Peer:', e);
      joinError.textContent = 'Could not start — try reloading the page.';
      joinError.hidden = false;
      return;
    }
    isHost = false;

    peer.on('open', () => {
      conn = peer.connect(ROOM_PREFIX + code, { reliable: true });
      conn.on('open', () => wireConnection());
      conn.on('error', (e) => {
        console.error('Connection error:', e);
        joinError.textContent = 'Could not connect — check the code and try again.';
        joinError.hidden = false;
      });
    });

    peer.on('disconnected', () => {
      if (peer && !peer.destroyed) {
        try { peer.reconnect(); } catch (e) { /* will retry via error handler below */ }
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'peer-unavailable') {
        joinError.textContent = 'No active room with that code. Double-check and try again.';
        joinError.hidden = false;
      } else if (err.type === 'network' || err.type === 'server-error') {
        joinError.textContent = 'Network issue reaching the signaling service — please try again.';
        joinError.hidden = false;
      } else {
        joinError.textContent = 'Connection error — please try again.';
        joinError.hidden = false;
      }
    });
  }

  function wireConnection() {
    waitingStatus.textContent = 'Peer found — connecting…';
    waitingStatus.classList.add('found');
    pulseStage.classList.add('found');

    function onReady() {
      setBadge('connected', 'Connected');
      peerIdShort.textContent = '#' + (conn.peer || '').replace(ROOM_PREFIX, '');
      setTimeout(() => showStage('connected'), 380); // let the pulse resolve visually first
    }

    // On the host side, PeerJS's incoming DataConnection can already be
    // open by the time we attach listeners (the 'open' event may have
    // already fired internally). `conn.open` reflects current state, so
    // check it directly instead of only waiting on the event.
    if (conn.open) {
      onReady();
    } else {
      conn.on('open', onReady);
    }

    conn.on('data', handleIncomingData);

    conn.on('close', () => {
      toast('Peer disconnected.', true);
      resetToIdle();
    });

    conn.on('error', (err) => {
      console.error('Connection error:', err);
      toast('Connection lost.', true);
    });
  }

  function resetToIdle() {
    closeScanner();
    setBadge('idle', 'Not connected');
    showStage('idle');
    transferList.innerHTML = '';
    incomingFiles.clear();
    outgoingQueue.length = 0;
    sending = false;
    if (conn) { try { conn.close(); } catch (e) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
  }

  // ==========================================================================
  // Sending files (chunked, with backpressure)
  // ==========================================================================

  function queueFiles(fileList) {
    Array.from(fileList).forEach((file) => {
      const fileId = 'f' + Date.now() + Math.random().toString(36).slice(2, 7);
      const row = createTransferRow(fileId, file.name, file.size, 'up');
      outgoingQueue.push({ file, fileId, row });
    });
    pumpQueue();
  }

  async function pumpQueue() {
    if (sending) return;
    const next = outgoingQueue.shift();
    if (!next) return;
    sending = true;
    await sendFile(next.file, next.fileId, next.row);
    sending = false;
    pumpQueue();
  }

  function sendFile(file, fileId, row) {
    return new Promise((resolve) => {
      conn.send({
        type: 'meta',
        fileId,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      });

      let offset = 0;
      const reader = new FileReader();

      function sendNextChunk() {
        if (offset >= file.size) {
          conn.send({ type: 'done', fileId });
          updateRow(row, 100, true);
          resolve();
          return;
        }

        // backpressure: if the underlying data channel buffer is full,
        // wait before reading/sending the next chunk
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > MAX_BUFFERED) {
          setTimeout(sendNextChunk, 40);
          return;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.onload = () => {
          conn.send({ type: 'chunk', fileId, data: reader.result });
          offset += slice.size;
          updateRow(row, Math.min(100, (offset / file.size) * 100), false);
          sendNextChunk();
        };
        reader.readAsArrayBuffer(slice);
      }

      sendNextChunk();
    });
  }

  // ==========================================================================
  // Receiving files
  // ==========================================================================

  const incomingFiles = new Map(); // fileId -> { name, size, mime, chunks, received, row }

  function handleIncomingData(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'meta') {
      incomingFiles.set(msg.fileId, {
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        chunks: [],
        received: 0,
        row: createTransferRow(msg.fileId, msg.name, msg.size, 'down'),
      });
      return;
    }

    if (msg.type === 'chunk') {
      const entry = incomingFiles.get(msg.fileId);
      if (!entry) return;
      entry.chunks.push(msg.data);
      entry.received += msg.data.byteLength || msg.data.length || 0;
      const pct = entry.size ? Math.min(100, (entry.received / entry.size) * 100) : 0;
      updateRow(entry.row, pct, false);
      return;
    }

    if (msg.type === 'done') {
      const entry = incomingFiles.get(msg.fileId);
      if (!entry) return;
      const blob = new Blob(entry.chunks, { type: entry.mime });
      const url = URL.createObjectURL(blob);
      finalizeRow(entry.row, url, entry.name);
      toast(`Received "${entry.name}"`);
      incomingFiles.delete(msg.fileId);
    }
  }

  // ==========================================================================
  // Transfer list UI
  // ==========================================================================

  function fileIconSvg() {
    return `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 1.5H9L12 4.5V12.5C12 13.05 11.55 13.5 11 13.5H4C3.45 13.5 3 13.05 3 12.5V2.5C3 1.95 3.45 1.5 4 1.5H3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.5V4.5H12" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  }

  function createTransferRow(fileId, name, size, direction) {
    const row = document.createElement('div');
    row.className = 'transfer-item';
    row.dataset.fileId = fileId;
    row.innerHTML = `
      <div class="ti-top">
        <div class="ti-icon">${fileIconSvg()}</div>
        <div class="ti-info">
          <div class="ti-name">${escapeHtml(name)}</div>
          <div class="ti-meta"><span class="pct">0%</span> · ${formatBytes(size)} · ${direction === 'up' ? 'sending' : 'receiving'}</div>
        </div>
      </div>
      <div class="ti-bar-track"><div class="ti-bar-fill" style="width:0%"></div></div>
    `;
    transferList.prepend(row);
    return row;
  }

  function updateRow(row, pct, done) {
    const fill = row.querySelector('.ti-bar-fill');
    const pctEl = row.querySelector('.pct');
    fill.style.width = pct.toFixed(0) + '%';
    pctEl.textContent = pct.toFixed(0) + '%';
    if (done) row.classList.add('done');
  }

  function finalizeRow(row, url, name) {
    row.classList.add('done');
    const top = row.querySelector('.ti-top');
    const existingAction = row.querySelector('.ti-action');
    if (existingAction) existingAction.remove();
    const meta = row.querySelector('.ti-meta');
    meta.innerHTML = `<span class="pct">100%</span> · received`;
    const btn = document.createElement('button');
    btn.className = 'ti-action';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    row.appendChild(btn);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ==========================================================================
  // Event wiring
  // ==========================================================================

  $('btnCreateRoom').addEventListener('click', createRoom);

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('joinCode').value.trim();
    if (!/^\d{6}$/.test(code)) {
      joinError.textContent = 'Enter the 6-digit code exactly as shown on the other device.';
      joinError.hidden = false;
      return;
    }
    joinRoom(code);
  });

  $('joinCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    $('btnJoin').classList.toggle('is-valid', e.target.value.length === 6);
  });

  btnScanQr.addEventListener('click', openScanner);
  btnCloseScan.addEventListener('click', closeScanner);
  qrScanModal.addEventListener('click', (e) => {
    if (e.target === qrScanModal) closeScanner(); // clicking the dimmed backdrop also closes it
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !qrScanModal.hidden) closeScanner();
  });
  $('btnCancelWait').addEventListener('click', resetToIdle);
  $('btnDisconnect').addEventListener('click', resetToIdle);

  $('btnCopyCode').addEventListener('click', () => {
    const code = roomCodeDisplay.textContent.replace(/\s/g, '');
    navigator.clipboard?.writeText(code).then(() => toast('Code copied'));
  });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) queueFiles(e.target.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) queueFiles(e.dataTransfer.files);
  });

  window.addEventListener('beforeunload', () => {
    if (conn) conn.close();
    if (peer) peer.destroy();
  });

})();