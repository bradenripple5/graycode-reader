async function jsonRequest(path, init) {
  const response = await fetch(path, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function createApiService() {
  return {
    fetchStatus() {
      return jsonRequest("/api/status");
    },
    sendJoints(positions, duration) {
      return jsonRequest("/api/joints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions, duration }),
      });
    },
    sendPose(pose, duration) {
      return jsonRequest("/api/pose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pose, duration }),
      });
    },
  };
}
