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
// FIND SUPPORTED RECORDING FORMAT
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
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        fileName: fileName(recordingStart),
        mimeType: recordingMimeType
      })
    }
  );

  const data = await response.json();

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
    "Google Drive upload session created."
  );
}


// ======================================================
// GET CURRENT GOOGLE DRIVE UPLOAD POSITION
// ======================================================

async function getUploadPosition() {

  const response = await fetch(
    driveUploadUrl,
    {
      method: "PUT",

      headers: {
        "Content-Range": "bytes */*"
      }
    }
  );

  // 308 means Google is telling us
  // how many bytes it already has.

  if (response.status === 308) {

    const range =
      response.headers.get("Range");

    if (!range) {
      return 0;
    }

    const match =
      range.match(/bytes=0-(\d+)/);

    if (!match) {
      return 0;
    }

    return Number(match[1]) + 1;
  }

  // If Google returns 200/201,
  // the upload is already complete.

  if (
    response.status === 200 ||
    response.status === 201
  ) {
    return uploadedBytes;
  }

  throw new Error(
    `Could not check Drive upload position: ${response.status}`
  );
}


// ======================================================
// UPLOAD ONE CHUNK TO GOOGLE DRIVE
// ======================================================

async function uploadChunk(blob) {

  if (
    !driveUploadUrl ||
    !blob ||
    !blob.size
  ) {
    return;
  }

  let attempts = 0;

  while (attempts < 5) {

    attempts++;

    // Ask Google what it actually has.
    // This prevents offset mismatch.
    try {
      uploadedBytes =
        await getUploadPosition();
    } catch (error) {

      console.warn(
        "Could not get upload position:",
        error
      );
    }

    const start =
      uploadedBytes;

    const end =
      start + blob.size - 1;

    console.log(
      `Uploading chunk ${start}-${end}`
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


    // ==================================================
    // UPLOAD FINISHED
    // ==================================================

    if (
      response.status === 200 ||
      response.status === 201
    ) {

      uploadedBytes =
        end + 1;

      console.log(
        `Google Drive upload completed. ${uploadedBytes} bytes`
      );

      return;
    }


    // ==================================================
    // CHUNK ACCEPTED
    // ==================================================

    if (response.status === 308) {

      const range =
        response.headers.get("Range");

      if (range) {

        const match =
          range.match(/bytes=0-(\d+)/);

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


    // ==================================================
    // OFFSET MISMATCH / TEMPORARY GOOGLE ERROR
    // ==================================================

    if (
      response.status === 400 ||
      response.status === 409 ||
      response.status === 503
    ) {

      console.warn(
        `Drive returned ${response.status}. Rechecking upload position...`
      );

      try {

        uploadedBytes =
          await getUploadPosition();

        console.log(
          `Corrected upload position: ${uploadedBytes}`
        );

        continue;

      } catch (error) {

        console.error(
          "Could not recover upload position:",
          error
        );

        await new Promise(
          resolve =>
            setTimeout(resolve, 1000)
        );

        continue;
      }
    }


    // ==================================================
    // OTHER ERROR
    // ==================================================

    const errorText =
      await response.text();

    throw new Error(
      `Drive upload failed: ${response.status} ${errorText}`
    );
  }

  throw new Error(
    "Drive upload failed after multiple attempts."
  );
}


// ======================================================
// QUEUE CHUNKS
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


  // ====================================================
  // NEW DATA CHUNK
  // ====================================================

  recorder.ondataavailable =
    event => {

      if (
        event.data &&
        event.data.size > 0
      ) {

        console.log(
          `New recording chunk: ${event.data.size} bytes`
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
        "Recording segment stopped."
      );

      try {

        await pendingUpload;

        console.log(
          "Recording segment upload finished."
        );

        recordingStatus.textContent =
          "✅ Recording saved to Google Drive";

      } catch (error) {

        console.error(
          "Final upload error:",
          error
        );

        recordingStatus.textContent =
          "❌ Recording upload error";
      }
    };


  // ====================================================
  // START MEDIA RECORDER
  // ====================================================

  recorder.start(10000);

  recordingStatus.textContent =
    "🔴 Recording to Google Drive";

  console.log(
    "Recording started."
  );


  // ====================================================
  // ONE HOUR SEGMENT
  // ====================================================

  segmentTimer =
    setTimeout(
      rotateRecording,
      60 * 60 * 1000
    );
}


// ======================================================
// ROTATE RECORDING EVERY ONE HOUR
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
    "One hour reached. Starting new recording segment..."
  );

  recorder.stop();

  // Give MediaRecorder time to fire
  // the final dataavailable event.

  await new Promise(
    resolve =>
      setTimeout(resolve, 1500)
  );

  try {

    await pendingUpload;

  } catch (error) {

    console.error(
      "Previous segment upload failed:",
      error
    );
  }

  // Create a completely new Drive file.
  await startRecording();
}


// ======================================================
// START CAMERA BUTTON
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
// ANSWER FROM VIEWER
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
