// ==========================================================================
// CONFIGURATIONS & INITIAL STATES
// ==========================================================================
const DEFAULT_API_URL = 'https://api.nadir.my.id';
const DEFAULT_WS_URL = 'wss://ws.nadir.my.id';

let API_URL = localStorage.getItem('DRIVER_API_URL') || DEFAULT_API_URL;
let WS_URL = localStorage.getItem('DRIVER_WS_URL') || DEFAULT_WS_URL;

let pois = [];
let activePoiId = null;
let currentQueueTab = 'standby'; // 'standby' or 'tandon'
let activeQueues = { standby: [], tandon: [] };
let socket = null;
let reconnectTimer = null;

// Developer Configuration Trigger (Click logo 5 times to open config modal)
let logoClickCount = 0;
document.querySelector('.brand-logo').addEventListener('click', () => {
  logoClickCount++;
  if (logoClickCount >= 5) {
    logoClickCount = 0;
    openConfigModal();
  }
  // Reset click count after 3 seconds of inactivity
  setTimeout(() => { logoClickCount = 0; }, 3000);
});

// ==========================================================================
// APP INITIALIZATION
// ==========================================================================
window.addEventListener('DOMContentLoaded', () => {
  // Load inputs in configuration modal
  document.getElementById('input-api-url').value = API_URL;
  document.getElementById('input-ws-url').value = WS_URL;
  
  // Initial fetch and connect
  initApp();
});

async function initApp() {
  try {
    updateConnectionStatus('connecting', 'Memuat data...');
    await fetchPOIs();
    if (pois.length > 0) {
      // Set the first POI as default active
      activePoiId = pois[0].id;
      renderPoiTabs();
      await fetchActiveQueue();
      connectWebSocket();
    } else {
      updateConnectionStatus('disconnected', 'Tidak ada POI');
      renderErrorState('poi-tabs', 'Tidak ada data pangkalan ditemukan.');
    }
  } catch (err) {
    console.error('Initialization error:', err);
    updateConnectionStatus('disconnected', 'Gagal memuat API');
    renderErrorState('poi-tabs', 'Gagal memuat data dari API. Silakan periksa pengaturan koneksi.');
  }
}

// ==========================================================================
// API CLIENTS
// ==========================================================================
async function fetchPOIs() {
  const response = await fetch(`${API_URL}/api/pois`);
  if (!response.ok) throw new Error('Failed to fetch POIs');
  pois = await response.json();
}

async function fetchActiveQueue() {
  if (!activePoiId) return;
  
  try {
    renderLoadingState();
    const response = await fetch(`${API_URL}/api/pois/${activePoiId}/queues`);
    if (!response.ok) throw new Error('Failed to fetch queues');
    const data = await response.json();
    
    activeQueues.standby = data.standby || [];
    activeQueues.tandon = data.tandon || [];
    
    updatePoiInfoCard(data.poi);
    renderQueueLists();
  } catch (err) {
    console.error(`Error fetching queue for POI ${activePoiId}:`, err);
    renderErrorState('queue-list-standby', 'Gagal memuat antrean standby.');
    renderErrorState('queue-list-tandon', 'Gagal memuat antrean tandon.');
  }
}

// ==========================================================================
// WEBSOCKET MANAGER (PERSISTENT & AUTO-RECONNECT)
// ==========================================================================
function connectWebSocket() {
  if (socket) {
    socket.close();
  }

  updateConnectionStatus('connecting', 'Menghubungkan WS...');
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    console.log('WebSocket successfully connected to', WS_URL);
    updateConnectionStatus('connected', 'Real-Time Aktif');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  socket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('WS Message received:', message);
      
      // Update queue when queue update event is received for the active POI
      if (message.type === 'QUEUE_UPDATE' && Number(message.poiId) === activePoiId) {
        await fetchActiveQueue();
      }
    } catch (err) {
      console.error('Error processing WS event data:', err);
    }
  };

  socket.onclose = () => {
    console.warn('WebSocket connection closed. Attempting reconnect...');
    updateConnectionStatus('disconnected', 'WS Terputus');
    triggerReconnect();
  };

  socket.onerror = (err) => {
    console.error('WebSocket error detected:', err);
    updateConnectionStatus('disconnected', 'WS Error');
  };
}

function triggerReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 5000); // Reconnect attempt every 5 seconds
}

// ==========================================================================
// RENDERING & INTERACTIVE ACTIONS
// ==========================================================================
function renderPoiTabs() {
  const container = document.getElementById('poi-tabs');
  container.innerHTML = '';
  
  pois.forEach(poi => {
    const button = document.createElement('button');
    button.className = `poi-tab-btn ${poi.id === activePoiId ? 'active' : ''}`;
    button.textContent = poi.name.replace('PANGKALAN ', '');
    button.onclick = () => switchPoiTab(poi.id);
    container.appendChild(button);
  });
}

function updatePoiInfoCard(poi) {
  if (!poi) return;
  
  document.getElementById('active-poi-name').textContent = poi.name;
  
  // Update status badge (Buka/Tutup)
  const statusBadge = document.getElementById('poi-status-badge');
  const now = new Date();
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const isOpen = poi.isOpen && currentTime >= poi.openTime && currentTime <= poi.closeTime;
  
  if (isOpen) {
    statusBadge.textContent = 'BUKA';
    statusBadge.className = 'status-badge online';
  } else {
    statusBadge.textContent = 'TUTUP';
    statusBadge.className = 'status-badge offline';
  }
  
  // Update hours badge
  document.getElementById('poi-hours-badge').textContent = `Jam Kerja: ${poi.openTime} - ${poi.closeTime}`;
  
  // Update counter values
  const restingCount = activeQueues.standby.filter(q => q.isResting).length + activeQueues.tandon.filter(q => q.isResting).length;
  document.getElementById('standby-count-value').textContent = activeQueues.standby.length;
  document.getElementById('tandon-count-value').textContent = activeQueues.tandon.length;
  document.getElementById('rest-count-value').textContent = restingCount;
}

function renderQueueLists() {
  renderList(activeQueues.standby, 'queue-list-standby');
  renderList(activeQueues.tandon, 'queue-list-tandon');
}

function renderList(drivers, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  
  if (drivers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-folder-open"></i>
        <p>Tidak ada armada di barisan ini.</p>
      </div>
    `;
    return;
  }
  
  drivers.forEach((driver, index) => {
    const card = document.createElement('div');
    card.className = `driver-card ${driver.isResting ? 'resting' : ''}`;
    
    // Hitung durasi waktu mengantre
    const joinedDate = new Date(driver.joinedAt);
    const diffMinutes = Math.floor((Date.now() - joinedDate.getTime()) / (1000 * 60));
    let timeLabel = `${diffMinutes} mnt`;
    if (diffMinutes >= 60) {
      const hours = Math.floor(diffMinutes / 60);
      const mins = diffMinutes % 60;
      timeLabel = `${hours} jam ${mins} mnt`;
    }
    
    const restBadge = driver.isResting ? `<span class="rest-indicator"><i class="fa-solid fa-mug-hot"></i> Istirahat</span>` : '';
    
    card.innerHTML = `
      <div class="driver-info-left">
        <div class="driver-position">${index + 1}</div>
        <div class="driver-hull-container">
          <span class="driver-hull">${driver.hullNumber}</span>
          <span class="driver-time">Masuk: ${formatTime(joinedDate)}</span>
        </div>
      </div>
      <div class="driver-status-right">
        ${restBadge}
        <span class="time-ago-badge">${timeLabel}</span>
      </div>
    `;
    container.appendChild(card);
  });
}

function switchPoiTab(poiId) {
  if (poiId === activePoiId) return;
  activePoiId = poiId;
  
  // Highlight active tab
  renderPoiTabs();
  
  // Fetch active queue data
  fetchActiveQueue();
}

function switchQueueTab(tabName) {
  if (tabName === currentQueueTab) return;
  currentQueueTab = tabName;
  
  // Toggle buttons
  document.getElementById('tab-btn-standby').classList.toggle('active', tabName === 'standby');
  document.getElementById('tab-btn-tandon').classList.toggle('active', tabName === 'tandon');
  
  // Toggle lists view
  document.getElementById('queue-list-standby').classList.toggle('active', tabName === 'standby');
  document.getElementById('queue-list-tandon').classList.toggle('active', tabName === 'tandon');
}

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function updateConnectionStatus(state, text) {
  const badge = document.getElementById('connection-badge');
  badge.className = `connection-badge ${state}`;
  badge.querySelector('.badge-text').textContent = text;
}

function formatTime(date) {
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderLoadingState() {
  const loader = `
    <div class="loading-state">
      <i class="fa-solid fa-circle-notch fa-spin"></i>
      <p>Memutakhirkan antrean...</p>
    </div>
  `;
  // Only replace content if there are no existing elements to reduce screen flicker
  const standby = document.getElementById('queue-list-standby');
  const tandon = document.getElementById('queue-list-tandon');
  if (standby.children.length === 0 || standby.querySelector('.loading-state')) {
    standby.innerHTML = loader;
  }
  if (tandon.children.length === 0 || tandon.querySelector('.loading-state')) {
    tandon.innerHTML = loader;
  }
}

function renderErrorState(containerId, message) {
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <div class="empty-state">
      <i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-red)"></i>
      <p>${message}</p>
    </div>
  `;
}

// ==========================================================================
// CONFIGURATIONS MODAL ACTIONS
// ==========================================================================
function openConfigModal() {
  document.getElementById('config-modal').classList.add('active');
}

function closeConfigModal() {
  document.getElementById('config-modal').classList.remove('active');
}

function saveConfigurations() {
  const inputApi = document.getElementById('input-api-url').value.trim();
  const inputWs = document.getElementById('input-ws-url').value.trim();
  
  if (!inputApi || !inputWs) {
    alert('URL API dan WebSocket tidak boleh kosong!');
    return;
  }
  
  localStorage.setItem('DRIVER_API_URL', inputApi);
  localStorage.setItem('DRIVER_WS_URL', inputWs);
  
  API_URL = inputApi;
  WS_URL = inputWs;
  
  closeConfigModal();
  initApp(); // Restart app with new configuration
}
