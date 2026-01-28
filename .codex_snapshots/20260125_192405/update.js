const updateEvents = new EventSource('/events');

function ensureBanner() {
  let banner = document.getElementById('updateStatus');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'updateStatus';
    banner.style.position = 'fixed';
    banner.style.right = '12px';
    banner.style.bottom = '12px';
    banner.style.padding = '8px 10px';
    banner.style.background = 'rgba(0, 0, 0, 0.7)';
    banner.style.color = '#fff';
    banner.style.fontSize = '13px';
    banner.style.borderRadius = '6px';
    banner.style.zIndex = '9999';
    banner.style.fontFamily = '"Times New Roman", serif';
    banner.textContent = 'SSE: connecting...';
    document.body.appendChild(banner);
  }
  return banner;
}

updateEvents.onopen = () => {
  console.log('update.js: SSE connected');
  const banner = ensureBanner();
  banner.textContent = 'SSE: connected';
};
updateEvents.onmessage = (event) => {
  console.log(`update.js: message=${event.data}`);
  const banner = ensureBanner();
  banner.textContent = `SSE: ${event.data || 'message'}`;
  if (event.data) {
    window.alert('message received');
  } else {
    console.log('update.js: empty message');
  }
};
updateEvents.onerror = (event) => {
  console.log('update.js: SSE error', event);
  const banner = ensureBanner();
  banner.textContent = 'SSE: error';
};
