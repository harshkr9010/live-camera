const socket = io();

let roomId;
let peerConnection;

const watchButton = document.getElementById("watchButton");
const roomInput = document.getElementById("roomId");
const remoteVideo = document.getElementById("remoteVideo");
const statusText = document.getElementById("status");

const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

watchButton.addEventListener("click", () => {
  roomId = roomInput.value.trim();
  if (!roomId) return alert("Enter a Room ID");

  socket.emit("join-room", roomId);
  statusText.innerText = "Waiting for camera...";
});

socket.on("offer", async offer => {
  peerConnection = new RTCPeerConnection(configuration);

  peerConnection.ontrack = event => {
    remoteVideo.srcObject = event.streams[0];
    statusText.innerText = "🔴 LIVE";
  };

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        roomId,
        candidate: event.candidate
      });
    }
  };

  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(offer)
  );

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit("answer", { roomId, answer });
});

socket.on("ice-candidate", async candidate => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error(error);
  }
});