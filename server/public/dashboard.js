/* eslint-env browser */

const API_BASE = '/admin/api/rooms';
let refreshInterval = null;
let videoPositionInterval = null;
let currentRoomDetails = null;

async function refreshRooms() {
  const container = document.getElementById('roomsContainer');
  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = document.getElementById('refreshIcon');

  refreshBtn.disabled = true;
  refreshIcon.innerHTML =
    '<div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>';

  try {
    const response = await fetch(API_BASE);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const rooms = await response.json();
    renderRooms(rooms);
    updateLastRefresh();
    clearAlert();
  } catch (error) {
    showAlert('error', `Failed to load rooms: ${error.message}`);
    container.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>Failed to load rooms. Please try again.</p></div>';
  } finally {
    refreshBtn.disabled = false;
    refreshIcon.textContent = '↻';
  }
}

// Expose refreshRooms to global scope for HTML onclick handlers
window.refreshRooms = refreshRooms;

function updateLastRefresh() {
  const now = new Date();
  document.getElementById('lastRefresh').textContent = `Last refresh: ${now.toLocaleTimeString()}`;
}

// Auto-refresh every 8 seconds
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(refreshRooms, 8000);
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
  refreshRooms();
  startAutoRefresh();
});

// Expose refreshRooms to global scope for HTML onclick handlers
window.refreshRooms = refreshRooms;

function renderRooms(rooms) {
  const container = document.getElementById('roomsContainer');

  if (rooms.length === 0) {
    container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <h3 style="margin-bottom: 8px;">No rooms found</h3>
                <p>Create your first room to get started.</p>
            </div>
        `;
    return;
  }

  const now = Date.now();
  container.innerHTML = '<div class="rooms-grid"></div>';
  const grid = container.querySelector('.rooms-grid');

  rooms.forEach(room => {
    const isExpired = room.expiresAt < now;
    const createdAt = new Date(room.createdAt);
    const timeRemaining = isExpired ? 'Expired' : formatTimeRemaining(room.expiresAt - now);

    const card = document.createElement('div');
    card.className = 'room-card';
    const displayName = room.name || room.id;
    card.innerHTML = `
            <div class="room-header">
                <div class="room-id">${displayName}</div>
                <div class="room-status ${isExpired ? 'status-expired' : 'status-active'}">
                    ${isExpired ? 'Expired' : 'Active'}
                </div>
            </div>
            <div class="room-info">
                <div class="info-item">
                    <div class="info-label">Participants</div>
                    <div class="info-value">${room.participantCount}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">State</div>
                    <div class="info-value">${room.last_state?.playerState || 'N/A'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Created</div>
                    <div class="info-value">${formatDate(createdAt)}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Expires</div>
                    <div class="info-value">${timeRemaining}</div>
                </div>
            </div>
            <div class="room-actions">
                <button class="btn btn-secondary" onclick="viewRoomDetails('${room.id}')">View Details</button>
                <button class="btn btn-danger" onclick="deleteRoom('${room.id}')">Delete</button>
            </div>
        `;
    grid.appendChild(card);
  });
}

// Expose functions to global scope for HTML onclick handlers
window.viewRoomDetails = async function viewRoomDetails(roomId) {
  const modal = document.getElementById('roomDetailsModal');
  const content = document.getElementById('roomDetailsContent');

  modal.classList.add('active');
  content.innerHTML =
    '<div class="loading"><div class="spinner"></div><p style="margin-top: 12px;">Loading room details...</p></div>';

  try {
    const response = await fetch(`${API_BASE}/${roomId}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const room = await response.json();
    renderRoomDetails(room);
  } catch (error) {
    content.innerHTML = `
            <div class="alert alert-error">
                <span>⚠️</span>
                <span>Failed to load room details: ${error.message}</span>
            </div>
        `;
  }
};

function renderRoomDetails(room) {
  const content = document.getElementById('roomDetailsContent');
  const createdAt = new Date(room.createdAt);
  const expiresAt = new Date(room.expiresAt);
  const isExpired = room.expiresAt < Date.now();
  const timeRemaining = isExpired ? 'Expired' : formatTimeRemaining(room.expiresAt - Date.now());
  
  // Store room data for video position updates
  currentRoomDetails = room;
  
  // Clear any existing interval
  if (videoPositionInterval) {
    clearInterval(videoPositionInterval);
    videoPositionInterval = null;
  }

  const clientsHtml =
    room.connectedClients.length > 0
      ? room.connectedClients
          .map(
            client => `
            <div class="client-item">
                <div style="flex: 1;">
                    <span>${client.clientId}</span>
                    <span style="color: #6b7280; font-size: 12px; margin-left: 8px;">Last seen: ${formatDate(new Date(client.lastSeen))}</span>
                </div>
                <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px;" onclick="removeClient('${room.roomId}', '${client.clientId}')">Remove</button>
            </div>
        `
          )
          .join('')
      : '<p style="color: #6b7280;">No connected clients</p>';

  const eventsHtml =
    room.recentEvents.length > 0
      ? room.recentEvents
          .slice()
          .reverse()
          .map(
            event => `
            <div class="event-item">
                <div>
                    <span class="event-type">${event.type}</span>
                    ${event.value !== undefined ? `<span style="color: #6b7280; margin-left: 8px;">${event.value}</span>` : ''}
                    ${event.clientId ? `<span style="color: #6b7280; margin-left: 8px;">(${event.clientId.substring(0, 8)}...)</span>` : ''}
                </div>
                <span class="event-time">${formatDate(new Date(event.ts))}</span>
            </div>
        `
          )
          .join('')
      : '<p style="color: #6b7280;">No recent events</p>';

  content.innerHTML = `
        <div class="details-section">
            <h3 class="details-section-title">Room Information</h3>
            <div class="details-grid">
                <div class="info-item">
                    <div class="info-label">Room ID</div>
                    <div class="info-value" style="font-family: 'Courier New', monospace;">${room.roomId}</div>
                </div>
                ${room.name ? `<div class="info-item">
                    <div class="info-label">Room Name</div>
                    <div class="info-value">${room.name}</div>
                </div>` : ''}
                <div class="info-item">
                    <div class="info-label">Status</div>
                    <div class="info-value">
                        <span class="room-status ${isExpired ? 'status-expired' : 'status-active'}">
                            ${isExpired ? 'Expired' : 'Active'}
                        </span>
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">Created</div>
                    <div class="info-value">${formatDate(createdAt)}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Expires</div>
                    <div class="info-value">${formatDate(expiresAt)}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Time Remaining</div>
                    <div class="info-value">${timeRemaining}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Target URL</div>
                    <div class="info-value" style="word-break: break-all;">${room.targetUrl}</div>
                </div>
            </div>
        </div>

        <div class="details-section">
            <h3 class="details-section-title">Playback State</h3>
            <div class="details-grid">
                <div class="info-item">
                    <div class="info-label">Player State</div>
                    <div class="info-value">${room.state.playerState}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Video Position</div>
                    <div class="info-value" id="roomDetailsVideoPos">${formatTime(room.state.videoPos)}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Provider</div>
                    <div class="info-value">${room.state.provider || 'N/A'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Episode</div>
                    <div class="info-value">${room.state.episode || 'N/A'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Event ID</div>
                    <div class="info-value">${room.state.eventId}</div>
                </div>
            </div>
        </div>

        <div class="details-section">
            <h3 class="details-section-title">Connected Clients (${room.connectedClients.length})</h3>
            <div class="clients-list">
                ${clientsHtml}
            </div>
        </div>

        <div class="details-section">
            <h3 class="details-section-title">Recent Events (${room.recentEvents.length})</h3>
            <div class="events-list">
                ${eventsHtml}
            </div>
        </div>

        <div style="margin-top: 24px; display: flex; gap: 12px;">
            <button class="btn btn-danger" onclick="deleteRoomFromDetails('${room.roomId}')">Delete Room</button>
            <button class="btn btn-secondary" onclick="closeRoomDetailsModal()">Close</button>
        </div>
    `;
  
  // Start updating video position if playing
  updateVideoPosition();
  if (room.state.playerState === 'playing') {
    videoPositionInterval = setInterval(updateVideoPosition, 100); // Update every 100ms
  }
}

function updateVideoPosition() {
  if (!currentRoomDetails) return;
  
  const videoPosEl = document.getElementById('roomDetailsVideoPos');
  if (!videoPosEl) return;
  
  const state = currentRoomDetails.state;
  let currentPos;
  
  if (state.playerState === 'playing' && state.last_explicit_event_ts) {
    // Calculate current position: videoPos at last event + elapsed time since then
    const elapsedSeconds = (Date.now() - state.last_explicit_event_ts) / 1000;
    currentPos = state.videoPos + elapsedSeconds;
  } else {
    // Paused: use static videoPos
    currentPos = state.videoPos;
    
    // If paused and interval is running, stop it
    if (videoPositionInterval) {
      clearInterval(videoPositionInterval);
      videoPositionInterval = null;
    }
  }
  
  videoPosEl.textContent = formatTime(currentPos);
}

window.closeRoomDetailsModal = function closeRoomDetailsModal() {
  // Clear video position update interval
  if (videoPositionInterval) {
    clearInterval(videoPositionInterval);
    videoPositionInterval = null;
  }
  currentRoomDetails = null;
  
  document.getElementById('roomDetailsModal').classList.remove('active');
};


window.closeCreateRoomModal = function closeCreateRoomModal() {
  // Reset modal to form view
  const formContainer = document.getElementById('createRoomFormContainer');
  const successContainer = document.getElementById('createRoomSuccessContainer');
  const modalTitle = document.getElementById('createRoomModalTitle');

  formContainer.style.display = 'block';
  successContainer.style.display = 'none';
  modalTitle.textContent = 'Create New Room';
  currentRoomCredentials = null;

  // Reset form and button state
  const form = document.getElementById('createRoomForm');
  if (form) {
    form.reset();
    
    // Reset submit button state
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Room';
    }
  }

  document.getElementById('createRoomModal').classList.remove('active');
};

window.handleCreateRoom = async function handleCreateRoom(event) {
  event.preventDefault();
  event.stopPropagation();

  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';

  const targetUrl = document.getElementById('targetUrl').value;
  const ttl = document.getElementById('ttl').value;
  const name = document.getElementById('roomName').value.trim();

  try {
    const body = { targetUrl };
    if (ttl) {
      body.ttl = parseInt(ttl, 10);
    }
    if (name) {
      body.name = name;
    }

    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('Room created successfully:', result);

    // Ensure modal stays open
    const modal = document.getElementById('createRoomModal');
    if (!modal.classList.contains('active')) {
      modal.classList.add('active');
    }

    showRoomCreationSuccess(result);
    // Don't refresh rooms immediately - let user see the credentials first
    // refreshRooms();
  } catch (error) {
    showAlert('error', `Failed to create room: ${error.message}`);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }

  return false;
};

let currentRoomCredentials = null;

function showRoomCreationSuccess(result) {
  console.log('showRoomCreationSuccess called with:', result);

  // Process share link - if it's relative, prepend current hostname
  let shareLink = result.shareLink || 'N/A';
  if (shareLink !== 'N/A' && shareLink.startsWith('/')) {
    const currentUrl = new URL(window.location.href);
    shareLink = `${currentUrl.protocol}//${currentUrl.host}${shareLink}`;
  }

  // Store credentials for copy function (with processed share link)
  currentRoomCredentials = {
    ...result,
    shareLink: shareLink
  };

  // Ensure modal is open
  const modal = document.getElementById('createRoomModal');
  if (!modal) {
    console.error('Modal element not found!');
    return;
  }
  modal.classList.add('active');

  // Hide form, show success view
  const formContainer = document.getElementById('createRoomFormContainer');
  const successContainer = document.getElementById('createRoomSuccessContainer');
  const modalTitle = document.getElementById('createRoomModalTitle');

  if (!formContainer || !successContainer || !modalTitle) {
    console.error('Required elements not found:', { formContainer, successContainer, modalTitle });
    return;
  }

  console.log('Switching to success view');
  formContainer.style.display = 'none';
  successContainer.style.display = 'block';
  modalTitle.textContent = 'Room Created';

  // Populate success view
  const roomIdEl = document.getElementById('successRoomId');
  const passwordEl = document.getElementById('successPassword');
  const shareLinkEl = document.getElementById('successShareLink');

  if (roomIdEl) {
    roomIdEl.textContent = result.roomId || 'N/A';
    console.log('Set roomId:', result.roomId);
  }
  if (passwordEl) {
    passwordEl.textContent = result.password || 'N/A';
    console.log('Set password:', result.password);
  }
  if (shareLinkEl) {
    shareLinkEl.textContent = shareLink;
    console.log('Set shareLink:', shareLink);
  }
}

window.copyRoomCredentials = function copyRoomCredentials() {
  if (!currentRoomCredentials) {
    return;
  }

  const url = currentRoomCredentials.shareLink

  // Format for Discord: share link and password on separate lines
  const discordFormat = `${url}\nPassword: \`${currentRoomCredentials.password}\``;

  // Use Clipboard API if available
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(discordFormat)
      .then(() => {
        showAlert('success', 'Room credentials copied to clipboard!');
      })
      .catch(() => {
        // Fallback for older browsers
        fallbackCopyToClipboard(discordFormat);
      });
  } else {
    // Fallback for older browsers
    fallbackCopyToClipboard(discordFormat);
  }
};

function fallbackCopyToClipboard(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      showAlert('success', 'Room credentials copied to clipboard!');
    } else {
      showAlert('error', 'Failed to copy. Please copy manually.');
    }
  } catch (err) {
    showAlert('error', 'Failed to copy. Please copy manually.');
  } finally {
    document.body.removeChild(textArea);
  }
}

window.openCreateRoomModal = function openCreateRoomModal() {
  // Reset modal to form view
  const formContainer = document.getElementById('createRoomFormContainer');
  const successContainer = document.getElementById('createRoomSuccessContainer');
  const modalTitle = document.getElementById('createRoomModalTitle');

  formContainer.style.display = 'block';
  successContainer.style.display = 'none';
  modalTitle.textContent = 'Create New Room';
  currentRoomCredentials = null;

  // Reset form and button state
  const form = document.getElementById('createRoomForm');
  form.reset();
  
  // Reset submit button state
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Room';
  }

  document.getElementById('createRoomModal').classList.add('active');
};

window.deleteRoom = async function deleteRoom(roomId) {
  if (
    !confirm(`Are you sure you want to delete room ${roomId}? This will disconnect all clients.`)
  ) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/${roomId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    showAlert('success', 'Room deleted successfully');
    refreshRooms();
  } catch (error) {
    showAlert('error', `Failed to delete room: ${error.message}`);
  }
};

window.deleteRoomFromDetails = function deleteRoomFromDetails(roomId) {
  window.closeRoomDetailsModal();
  window.deleteRoom(roomId);
};

window.removeClient = async function removeClient(roomId, clientId) {
  if (
    !confirm(`Are you sure you want to remove client ${clientId.substring(0, 8)}... from this room?`)
  ) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/${roomId}/clients/${clientId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    showAlert('success', 'Client removed successfully');
    // Refresh room details to update the client list
    if (currentRoomDetails && currentRoomDetails.roomId === roomId) {
      window.viewRoomDetails(roomId);
    }
  } catch (error) {
    showAlert('error', `Failed to remove client: ${error.message}`);
  }
};

function showAlert(type, message) {
  const container = document.getElementById('alertContainer');
  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.innerHTML = `
        <span>${type === 'error' ? '⚠️' : '✓'}</span>
        <span>${message}</span>
    `;
  container.appendChild(alert);

  setTimeout(() => {
    alert.remove();
  }, 5000);
}

function clearAlert() {
  document.getElementById('alertContainer').innerHTML = '';
}

function formatDate(date) {
  return date.toLocaleString();
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTimeRemaining(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Close modals on outside click
document.getElementById('createRoomModal').addEventListener('click', e => {
  if (e.target.id === 'createRoomModal') {
    // eslint-disable-next-line no-undef
    window.closeCreateRoomModal();
  }
});

document.getElementById('roomDetailsModal').addEventListener('click', e => {
  if (e.target.id === 'roomDetailsModal') {
    // eslint-disable-next-line no-undef
    window.closeRoomDetailsModal();
  }
});
