(() => {
  const query = `t=${new URLSearchParams(location.search).get('t')}&id=${crypto.randomUUID()}`;
  const events = new EventSource(`/events?${query}`);
  const opened = new Promise((resolve) => events.addEventListener('open', resolve, { once: true }));
  events.onmessage = (event) => window.postMessage(JSON.parse(event.data), location.origin);
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => opened.then(() => fetch(`/message?${query}`, { method: 'POST', body: JSON.stringify(message) })),
  });
})();
