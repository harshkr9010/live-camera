const socket = io();

let roomId;
let localStream;
let peerConnection;
let recorder;

let uploadSessionId = null;
let uploadedBytes = 0;

// Buffer for Google Drive's 256 KiB requirement
let pendingBytes = new Uint8Array(0);

let recordingMimeType;
let recordingStart;
let segmentTimer;

let pendingUpload = Promise.resolve();

const CHUNK_SIZE = 262144;

// ======================================================
// 10 MINUTE RECORDING
// ======================================================

const RECORDING_DURATION = 10 * 60 * 1000;


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
// FIND SUPPORTED MIME TYPE
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
// CREATE FILE NAME
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
// CREATE GOOGLE DRIVE UPLOAD SESSION
// ======================================================

async function createSession() {

  console.log(
    "Creating Google Drive upload session..."
  );

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
      "Server did not return upload session."
    );
  }

  uploadSessionId =
    data.sessionId;

  uploadedBytes = 0;

  pendingBytes =
    new Uint8Array(0);

  console.log(
    "Google Drive upload session created:",
    uploadSessionId
  );
}


// ======================================================
// ADD MEDIARECORDER CHUNK TO BUFFER
// ======================================================

async function addToBuffer(blob) {

  const newBytes =
    new Uint8Array(
      await blob.arrayBuffer()
    );

  const combined =
    new Uint8Array(
      pendingBytes.length +
      newBytes.length
    );

  combined.set(
    pendingBytes,
    0
  );

  combined.set(
    newBytes,
    pendingBytes.length
  );

  pendingBytes =
    combined;

  console.log(
    "Buffered bytes:",
    pendingBytes.length
  );
}


// ======================================================
// UPLOAD 256 KiB BLOCK
// ======================================================

async function uploadBlock(bytes) {

  const start =
    uploadedBytes;

  const end =
    start +
    bytes.length -
    1;

  console.log(
    `Uploading block ${start}-${end} (${bytes.length} bytes)`
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

        body: bytes
      }
    );


  // Upload completed
  if (
    response.status === 200 ||
    response.status === 201
  ) {

    uploadedBytes =
      end + 1;

    console.log(
      "Google Drive upload completed."
    );

    return;
  }


  // More data required
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
// PROCESS BUFFER
// ======================================================

async function processBuffer() {

  while (
    pendingBytes.length >=
    CHUNK_SIZE
  ) {

    const block =
      pendingBytes.slice(
        0,
        CHUNK_SIZE
      );

    pendingBytes =
      pendingBytes.slice(
        CHUNK_SIZE
      );

    await uploadBlock(block);
  }
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
      .then(async () => {

        await addToBuffer(blob);

        await processBuffer();

      })
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
// FINALIZE CURRENT 10-MINUTE FILE
// ======================================================

async function finalizeUpload() {

  await pendingUpload;


  // Nothing remaining
  if (
    pendingBytes.length === 0
  ) {

    console.log(
      "No remaining bytes."
    );

    return;
  }


  const finalBytes =
    pendingBytes;

  const start =
    uploadedBytes;

  const end =
    start +
    finalBytes.length -
    1;

  const total =
    end + 1;


  console.log(
    `Uploading final block ${start}-${end}/${total}`
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
            `bytes ${start}-${end}/${total}`
        },

        body: finalBytes
      }
    );


  if (
    response.status !== 200 &&
    response.status !== 201
  ) {

    const errorText =
      await response.text();

    throw new Error(
      `Final Drive upload failed: ${response.status} ${errorText}`
    );
  }


  uploadedBytes =
    total;

  pendingBytes =
    new Uint8Array(0);

  console.log(
    `🎉 Google Drive file finalized: ${total} bytes`
  );
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


  // ====================================================
  // NEW CHUNK
  // ====================================================

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


  // ====================================================
  // RECORDING STOPPED
  // ====================================================

  recorder.onstop =
    async () => {

      console.log(
        "10-minute recording stopped."
      );

      try {

        await finalizeUpload();

        recordingStatus.textContent =
          "✅ Recording saved to Google Drive";

        console.log(
          "🎥 Recording successfully saved."
        );

      } catch (error) {

        console.error(
          "Final recording upload error:",
          error
        );

        recordingStatus.textContent =
          "❌ Recording upload error";
      }
    };


  // Record in small browser chunks.
  // The code combines them before
  // sending to Google Drive.

  recorder.start(10000);


  recordingStatus.textContent =
    "🔴 Recording to Google Drive";


  console.log(
    "Recording started."
  );


  // ====================================================
  // STOP AFTER 10 MINUTES
  // ====================================================

  segmentTimer =
    setTimeout(
      rotateRecording,
      RECORDING_DURATION
    );
}


// ======================================================
// ROTATE EVERY 10 MINUTES
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
    "⏰ 10 minutes reached."
  );


  console.log(
    "Stopping current recording..."
  );


  // This creates the final MediaRecorder chunk.
  recorder.stop();


  // Wait for MediaRecorder to become inactive.

  await new Promise(
    resolve => {

      const check =
        setInterval(() => {

          if (
            recorder.state ===
            "inactive"
          ) {

            clearInterval(
              check
            );

            resolve();
          }

        }, 500);

    }
  );


  try {

    await pendingUpload;

  } catch (error) {

    console.error(
      "Previous segment upload failed:",
      error
    );
  }


  // Start a completely new
  // Google Drive file.

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
