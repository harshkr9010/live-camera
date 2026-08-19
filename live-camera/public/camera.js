const socket=io();
let roomId,localStream,peerConnection,recorder,driveUploadUrl,uploadedBytes=0,recordingMimeType,recordingStart,segmentTimer;
let pendingUpload=Promise.resolve();
const startButton=document.getElementById("startButton"),roomInput=document.getElementById("roomId"),localVideo=document.getElementById("localVideo"),statusText=document.getElementById("status"),recordingStatus=document.getElementById("recordingStatus");
const configuration={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};

function mimeType(){return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(x=>MediaRecorder.isTypeSupported(x))||"";}
function fileName(t){const d=new Date(t),p=n=>String(n).padStart(2,"0");return `camera-${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.webm`;}

async function createSession(){
  const r=await fetch("/api/drive/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fileName:fileName(recordingStart),mimeType:recordingMimeType})});
  const data=await r.json(); if(!r.ok) throw new Error(data.error||"Drive session failed");
  driveUploadUrl=data.uploadUrl; uploadedBytes=0;
}

async function uploadChunk(blob){
  if(!driveUploadUrl||!blob||!blob.size)return;
  const start=uploadedBytes,end=start+blob.size-1;
  const r=await fetch(driveUploadUrl,{method:"PUT",headers:{"Content-Type":recordingMimeType,"Content-Range":`bytes ${start}-${end}/*`},body:blob});
  if(r.status!==200&&r.status!==201&&r.status!==308)throw new Error(`Drive upload failed: ${r.status} ${await r.text()}`);
  uploadedBytes+=blob.size;
}

async function startRecording(){
  recordingMimeType=mimeType();
  if(!recordingMimeType)throw new Error("This browser does not support WebM recording.");
  recordingStart=Date.now();
  await createSession();
  recorder=new MediaRecorder(localStream,{mimeType:recordingMimeType,videoBitsPerSecond:2500000,audioBitsPerSecond:128000});
  recorder.ondataavailable=e=>{if(e.data?.size)pendingUpload=pendingUpload.then(()=>uploadChunk(e.data)).catch(err=>{console.error(err);recordingStatus.textContent="Recording upload error";});};
  recorder.start(10000);
  recordingStatus.textContent="🔴 Recording to Google Drive";
  segmentTimer=setTimeout(rotateRecording,3600000);
}

async function rotateRecording(){
  clearTimeout(segmentTimer);
  if(!recorder||recorder.state==="inactive")return;
  recorder.stop();
  await new Promise(r=>setTimeout(r,1500));
  await pendingUpload;
  await startRecording();
}

startButton.addEventListener("click",async()=>{
  roomId=roomInput.value.trim(); if(!roomId)return alert("Enter a Room ID");
  startButton.disabled=true;
  try{
    localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    localVideo.srcObject=localStream; socket.emit("join-room",roomId); statusText.textContent="Camera started. Waiting for viewer...";
    await startRecording();
  }catch(e){console.error(e);alert(e.message||"Could not access camera/microphone.");startButton.disabled=false;}
});

socket.on("user-joined",async()=>{
  if(!localStream)return;
  peerConnection=new RTCPeerConnection(configuration);
  localStream.getTracks().forEach(track=>peerConnection.addTrack(track,localStream));
  peerConnection.onicecandidate=e=>{if(e.candidate)socket.emit("ice-candidate",{roomId,candidate:e.candidate});};
  const offer=await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); socket.emit("offer",{roomId,offer}); statusText.textContent="Viewer connected. Connecting...";
});
socket.on("answer",async answer=>{if(peerConnection){await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));statusText.textContent="🔴 LIVE";}});
socket.on("ice-candidate",async candidate=>{if(peerConnection)try{await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));}catch(e){console.error(e);}});
window.addEventListener("beforeunload",()=>{if(segmentTimer)clearTimeout(segmentTimer);if(recorder&&recorder.state!=="inactive")recorder.stop();});
