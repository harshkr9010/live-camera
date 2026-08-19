const socket=io();let roomId,peerConnection;
const watchButton=document.getElementById("watchButton"),roomInput=document.getElementById("roomId"),remoteVideo=document.getElementById("remoteVideo"),statusText=document.getElementById("status");
const configuration={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
watchButton.addEventListener("click",()=>{roomId=roomInput.value.trim();if(!roomId)return alert("Enter a Room ID");socket.emit("join-room",roomId);statusText.textContent="Waiting for camera...";});
socket.on("offer",async offer=>{peerConnection=new RTCPeerConnection(configuration);peerConnection.ontrack=e=>{remoteVideo.srcObject=e.streams[0];statusText.textContent="🔴 LIVE";};peerConnection.onicecandidate=e=>{if(e.candidate)socket.emit("ice-candidate",{roomId,candidate:e.candidate});};await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));const answer=await peerConnection.createAnswer();await peerConnection.setLocalDescription(answer);socket.emit("answer",{roomId,answer});});
socket.on("ice-candidate",async candidate=>{if(peerConnection)try{await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));}catch(e){console.error(e);}});
