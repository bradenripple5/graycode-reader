const updateEvents = new EventSource('/events');
updateEvents.onopen = () => {
  console.log('update.js: SSE connected');
};
updateEvents.onmessage = (event) => {
  console.log(`update.js: message=${event.data}`);
  if (event.data) {
    window.alert('message received');
  } else {
    console.log('update.js: empty message');
  }
};
updateEvents.onerror = (event) => {
  console.log('update.js: SSE error', event);
};
