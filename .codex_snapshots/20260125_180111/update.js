const updateEvents = new EventSource('/events');
updateEvents.onmessage = (event) => {
      console.log('message received')

  if (event.data) {
    window.alert('message received');
  }
  else{
    console.log('but data has not been yet received')
  }
};
