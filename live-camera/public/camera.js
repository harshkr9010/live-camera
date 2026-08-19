const socket = io();

let roomId;
let localStream;
let peerConnection;
let recorder;

let driveUploadUrl = null;
let uploadedBytes = 0;

let recordingMimeType;
let recordingStart;
let segmentTimer;

let pendingUpload = Promise.resolve();

const startButton =
  document.getElementById("startButton");

const roomInput =
  document.getElementById("roomId");

const localVideo =
  document.getElementById("localVideo");

const statusText =
  document.getElementById("status");

const recordingStatus =
  document.getElementById("recordingStatus");

const configuration = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};


// ======================================================
// MIME TYPE
// ======================================================

function getMimeType() {

  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  return (
    types.find(type =>
      MediaRecorder.isTypeSupported(type)
    ) || ""
  );
}


// ======================================================
// FILE NAME
// ======================================================

function fileName(timestamp) {

  const d = new Date(timestamp);

  const pad = number =>
    String(number).padStart(2, "0");

  return (
    `camera-${d.getFullYear()}-` +
    `${pad(d.getMonth() + 1)}-` +
    `${pad(d.getDate())}_` +
    `${pad(d.getHours())}-` +
    `${pad(d.getMinutes())}-` +
    `${pad(d.getSeconds())}.webm`
  );
}


// ======================================================
// CREATE GOOGLE DRIVE UPLOAD SESSION
// ======================================================

async function createSession() {

  console.log(
    "Creating Google Drive upload session..."
  );

  const response = await fetch(
    "/api/drive/session",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        fileName:
          fileName(recordingStart),

        mimeType:
          recordingMimeType
      })
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data.error ||
      "Drive session failed."
    );
  }

  if (!data.uploadUrl) {
    throw new Error(
      "Google Drive did not return an upload URL."
    );
  }

  driveUploadUrl =
    data.uploadUrl;

  uploadedBytes = 0;

  console.log(
    "Google Drive upload session ready."
  );
}


// ======================================================
// UPLOAD ONE RECORDING CHUNK
// ======================================================

async function uploadChunk(blob) {

  if (
    !driveUploadUrl ||
    !blob ||
    !blob.size
  ) {
    return;
  }

  const start =
    uploadedBytes;

  const end =
    start + blob.size - 1;

  console.log(
    `Uploading bytes ${start}-${end}`
  );

  const response =
    await fetch(
      driveUploadUrl,
      {
        method: "PUT",

        headers: {
          "Content-Type":
            recordingMimeType,

          "Content-Range":
            `bytes ${start}-${end}/*`
        },

        body: blob
      }
    );

  // 308 = Google Drive accepted the chunk
  // but the file is not finished yet.

  if (
    response.status !== 200 &&
    response.status !== 201 &&
    response.status !== 308
  ) {

    const text =
      await response.text();

    throw new Error(
      `Drive upload failed: ${response.status} ${text}`
    );
  }

  uploadedBytes +=
    blob.size;

  console.log(
    `Uploaded ${uploadedBytes} bytes`
  );
}


// ======================================================
// QUEUE UPLOAD
// ======================================================

function queueUpload(blob) {

  if (!blob || !blob.size) {
    return;
  }

  pendingUpload =
    pendingUpload
      .then(() =>
        uploadChunk(blob)
      )
      .catch(error => {

        console.error(
          "Google Drive upload error:",
          error
        );

        recordingStatus.textContent =
          "❌ Recording upload error";

        throw error;
      });
}


// ======================================================
// START RECORDING
// ======================================================

async function startRecording() {

  recordingMimeType =
    getMimeType();

  if (!recordingMimeType) {

    throw new Error(
      "This browser does not support WebM recording."
    );
  }

  recordingStart =
    Date.now();

  await createSession();

  recorder =
    new MediaRecorder(
      localStream,
      {
        mimeType:
          recordingMimeType,

        videoBitsPerSecond:
          2500000,

        audioBitsPerSecond:
          128000
      }
    );


  // --------------------------------------------------
  // Recording data
  // --------------------------------------------------

  recorder.ondataavailable =
    event => {

      if (
        event.data &&
        event.data.size > 0
      ) {

        queueUpload(
          event.data
        );
      }
    };


  // --------------------------------------------------
  // Recording stopped
  // --------------------------------------------------

  recorder.onstop =
    async () => {

      console.log(
        "Recording segment stopped."
      );

      try {

        await pendingUpload;

        console.log(
          "Current segment uploaded."
        );

      } catch (error) {

        console.error(
          "Final segment upload failed:",
          error
        );
      }
    };


  // --------------------------------------------------
  // Start recorder
  // --------------------------------------------------

  recorder.start(10000);

  recordingStatus.textContent =
    "🔴 Recording to Google Drive";

  console.log(
    "Recording started."
  );


  // --------------------------------------------------
  // One-hour segment
  // --------------------------------------------------

  segmentTimer =
    setTimeout(
      rotateRecording,
      60 * 60 * 1000
    );
}


// ======================================================
// ROTATE RECORDING EVERY HOUR
// ======================================================

async function rotateRecording() {

  clearTimeout(
    segmentTimer
  );

  if (
    !recorder ||
    recorder.state === "inactive"
  ) {
    return;
  }

  console.log(
    "One hour reached. Rotating recording..."
  );

  recorder.stop();

  // Wait for the final dataavailable event
  await new Promise(resolve =>
    setTimeout(resolve, 1000)
  );

  try {

    await pendingUpload;

  } catch (error) {

    console.error(
      "Previous segment failed:",
      error
    );
  }

  // Start a completely new Drive file
  await startRecording();
}


// ======================================================
// START CAMERA
// ======================================================

startButton.addEventListener(
  "click",
  async () => {

    roomId =
      roomInput.value.trim();

    if (!roomId) {

      alert(
        "Enter a Room ID"
      );

      return;
    }

    startButton.disabled =
      true;

    try {

      localStream =
        await navigator.mediaDevices
          .getUserMedia({
            video: true,
            audio: true
          });

      localVideo.srcObject =
        localStream;

      socket.emit(
        "join-room",
        roomId
      );

      statusText.textContent =
        "Camera started. Waiting for viewer...";

      await startRecording();

    } catch (error) {

      console.error(
        error
      );

      alert(
        error.message ||
        "Could not access camera/microphone."
      );

      startButton.disabled =
        false;
    }
  }
);


// ======================================================
// VIEWER CONNECTED
// ======================================================

socket.on(
  "user-joined",
  async () => {

    if (!localStream) {
      return;
    }

    peerConnection =
      new RTCPeerConnection(
        configuration
      );

    localStream
      .getTracks()
      .forEach(track => {

        peerConnection.addTrack(
          track,
          localStream
        );
      });


    peerConnection.onicecandidate =
      event => {

        if (event.candidate) {

          socket.emit(
            "ice-candidate",
            {
              roomId,
              candidate:
                event.candidate
            }
          );
        }
      };


    const offer =
      await peerConnection
        .createOffer();

    await peerConnection
      .setLocalDescription(
        offer
      );

    socket.emit(
      "offer",
      {
        roomId,
        offer
      }
    );

    statusText.textContent =
      "Viewer connected. Connecting...";
  }
);


// ======================================================
// ANSWER
// ======================================================

socket.on(
  "answer",
  async answer => {

    if (!peerConnection) {
      return;
    }

    await peerConnection
      .setRemoteDescription(
        new RTCSessionDescription(
          answer
        )
      );

    statusText.textContent =
      "🔴 LIVE";
  }
);


// ======================================================
// ICE CANDIDATE
// ======================================================

socket.on(
  "ice-candidate",
  async candidate => {

    if (!peerConnection) {
      return;
    }

    try {

      await peerConnection
        .addIceCandidate(
          new RTCIceCandidate(
            candidate
          )
        );

    } catch (error) {

      console.error(
        "ICE candidate error:",
        error
      );
    }
  }
);


// ======================================================
// CLEANUP
// ======================================================

window.addEventListener(
  "beforeunload",
  () => {

    if (segmentTimer) {

      clearTimeout(
        segmentTimer
      );
    }

    if (
      recorder &&
      recorder.state !== "inactive"
    ) {

      recorder.stop();
    }

    if (localStream) {

      localStream
        .getTracks()
        .forEach(track =>
          track.stop()
        );
    }
  }
);
