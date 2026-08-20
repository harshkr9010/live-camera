const socket = io();

let roomId;
let localStream;
let peerConnection;
let recorder;

let uploadSessionId = null;
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

  const pad =
    n => String(n).padStart(2, "0");

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
// CREATE SERVER UPLOAD SESSION
// ======================================================

async function createSession() {

  const response =
    await fetch(
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

  if (!data.sessionId) {

    throw new Error(
      "Server did not return an upload session."
    );
  }

  uploadSessionId =
    data.sessionId;

  uploadedBytes = 0;

  console.log(
    "Upload session created:",
    uploadSessionId
  );
}

// ======================================================
// UPLOAD CHUNK THROUGH RENDER
// ======================================================

async function uploadChunk(blob) {

  if (
    !uploadSessionId ||
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
    `Sending chunk ${start}-${end} to Render`
  );

  const response =
    await fetch(
      "/api/drive/chunk",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/octet-stream",

          "X-Upload-Session":
            uploadSessionId,

          "Content-Range":
            `bytes ${start}-${end}/*`
        },

        body: blob
      }
    );

  if (
    response.status === 200 ||
    response.status === 201
  ) {

    uploadedBytes =
      end + 1;

    console.log(
      "Google Drive file completed."
    );

    return;
  }

  if (
    response.status === 308
  ) {

    const range =
      response.headers.get(
        "Range"
      );

    if (range) {

      const match =
        range.match(
          /bytes=0-(\d+)/
        );

      if (match) {

        uploadedBytes =
          Number(match[1]) + 1;

      } else {

        uploadedBytes =
          end + 1;
      }

    } else {

      uploadedBytes =
        end + 1;
    }

    console.log(
      `Google Drive confirmed ${uploadedBytes} bytes`
    );

    return;
  }

  const errorText =
    await response.text();

  throw new Error(
    `Drive upload failed: ${response.status} ${errorText}`
  );
}

// ======================================================
// QUEUE UPLOAD
// ======================================================

function queueUpload(blob) {

  if (
    !blob ||
    !blob.size
  ) {
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

  recorder.ondataavailable =
    event => {

      if (
        event.data &&
        event.data.size > 0
      ) {

        console.log(
          "New recording chunk:",
          event.data.size,
          "bytes"
        );

        queueUpload(
          event.data
        );
      }
    };

  recorder.onstop =
    async () => {

      try {

        await pendingUpload;

        recordingStatus.textContent =
          "✅ Recording saved to Google Drive";

      } catch (error) {

        console.error(
          error
        );

        recordingStatus.textContent =
          "❌ Recording upload error";
      }
    };

  // Create a chunk every 10 seconds
  recorder.start(10000);

  recordingStatus.textContent =
    "🔴 Recording to Google Drive";

  console.log(
    "Recording started."
  );

  // New 1-hour file
  segmentTimer =
    setTimeout(
      rotateRecording,
      60 * 60 * 1000
    );
}

// ======================================================
// ROTATE EVERY HOUR
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
    "One hour reached. Creating new recording."
  );

  recorder.stop();

  // Allow final MediaRecorder chunk
  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        1500
      )
  );

  try {

    await pendingUpload;

  } catch (error) {

    console.error(
      "Previous upload failed:",
      error
    );
  }

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
        await navigator
          .mediaDevices
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
// VIEWER JOINED
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
// ICE
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
