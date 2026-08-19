const socket = io();

let roomId;
let localStream;
let peerConnection;

const startButton = document.getElementById("startButton");
const roomInput = document.getElementById("roomId");
const localVideo = document.getElementById("localVideo");
const statusText = document.getElementById("status");

const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

startButton.addEventListener("click", async () => {
  roomId = roomInput.value.trim();
  if (!roomId) return alert("Enter a Room ID");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    localVideo.srcObject = localStream;
    socket.emit("join-room", roomId);
    statusText.innerText = "Camera started. Waiting for viewer...";
  } catch (error) {
    console.error(error);
    alert("Could not access camera/microphone.");
  }
});

socket.on("user-joined", async () => {
  if (!localStream) return;

  peerConnection = new RTCPeerConnection(configuration);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        roomId,
        candidate: event.candidate
      });
    }
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit("offer", { roomId, offer });
  statusText.innerText = "Viewer connected. Connecting...";
});

socket.on("answer", async answer => {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(answer)
  );
  statusText.innerText = "🔴 LIVE";
});

socket.on("ice-candidate", async candidate => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error(error);
  }
});