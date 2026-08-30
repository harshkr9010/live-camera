const socket = io();

let roomId = "";
let peerConnection = null;
let watching = false;


// ======================================================
// HTML
// ======================================================

const watchButton =
    document.getElementById("watchButton");

const roomInput =
    document.getElementById("roomId");

const remoteVideo =
    document.getElementById("remoteVideo");

const statusText =
    document.getElementById("status");

const viewerCountText =
    document.getElementById("viewerCount");


// ======================================================
// WEBRTC
// ======================================================

const configuration = {

    iceServers: [

        {
            urls:
                "stun:stun.l.google.com:19302"
        }

    ]

};


// ======================================================
// WATCH BUTTON
// ======================================================

watchButton.addEventListener(
    "click",
    startWatching
);


// ======================================================
// START WATCHING
// ======================================================

function startWatching() {

    if (watching) {
        return;
    }


    roomId =
        roomInput.value.trim();


    if (!roomId) {

        alert(
            "Enter a Room ID first."
        );

        return;
    }


    watching = true;


    watchButton.disabled =
        true;

    roomInput.disabled =
        true;


    statusText.textContent =
        "Connecting to camera...";


    socket.emit(
        "join-room",
        roomId
    );

}


// ======================================================
// ROLE
// ======================================================

socket.on(
    "role",
    (role) => {

        if (role === "camera") {

            statusText.textContent =
                "This room is already being used by a camera.";

        }

        if (role === "viewer") {

            statusText.textContent =
                "Waiting for camera...";

        }

    }
);


// ======================================================
// CAMERA AVAILABLE
// ======================================================

socket.on(
    "camera-available",
    ({ cameraId }) => {

        console.log(
            "Camera available:",
            cameraId
        );


        statusText.textContent =
            "Connecting to camera...";

    }
);


// ======================================================
// RECEIVE OFFER
// ======================================================

socket.on(
    "offer",
    async ({
        cameraId,
        offer
    }) => {

        console.log(
            "Offer received from camera:",
            cameraId
        );


        try {

            // Close old connection
            if (peerConnection) {

                peerConnection.close();

            }


            peerConnection =
                new RTCPeerConnection(
                    configuration
                );


            // ==================================================
            // RECEIVE VIDEO + AUDIO
            // ==================================================

            peerConnection.ontrack =
                (event) => {

                    console.log(
                        "Live track received:",
                        event.track.kind
                    );


                    if (
                        event.streams &&
                        event.streams[0]
                    ) {

                        remoteVideo.srcObject =
                            event.streams[0];

                    }

                    statusText.textContent =
                        "🔴 LIVE";

                    // Try to start playback
                    remoteVideo
                        .play()
                        .catch(
                            () => {
                                // Browser may require
                                // the user to press play.
                            }
                        );

                };


            // ==================================================
            // ICE
            // ==================================================

            peerConnection.onicecandidate =
                (event) => {

                    if (
                        event.candidate
                    ) {

                        socket.emit(
                            "ice-candidate",
                            {
                                targetId:
                                    cameraId,

                                candidate:
                                    event.candidate
                            }
                        );

                    }

                };


            // ==================================================
            // CONNECTION STATE
            // ==================================================

            peerConnection.onconnectionstatechange =
                () => {

                    console.log(
                        "Connection:",
                        peerConnection.connectionState
                    );


                    switch (
                        peerConnection.connectionState
                    ) {

                        case "connected":

                            statusText.textContent =
                                "🔴 LIVE";

                            break;


                        case "connecting":

                            statusText.textContent =
                                "Connecting...";

                            break;


                        case "disconnected":

                            statusText.textContent =
                                "⚠️ Connection interrupted";

                            break;


                        case "failed":

                            statusText.textContent =
                                "❌ Connection failed";

                            break;


                        case "closed":

                            statusText.textContent =
                                "Connection closed";

                            break;

                    }

                };


            // ==================================================
            // SET OFFER
            // ==================================================

            await peerConnection.setRemoteDescription(
                new RTCSessionDescription(
                    offer
                )
            );


            // ==================================================
            // CREATE ANSWER
            // ==================================================

            const answer =
                await peerConnection.createAnswer();


            await peerConnection.setLocalDescription(
                answer
            );


            // ==================================================
            // SEND ANSWER TO CAMERA
            // ==================================================

            socket.emit(
                "answer",
                {
                    cameraId,
                    answer
                }
            );


            console.log(
                "Answer sent to camera"
            );


        } catch (error) {

            console.error(
                "Viewer connection error:",
                error
            );


            statusText.textContent =
                "❌ Could not connect to camera";

        }

    }
);


// ======================================================
// ICE CANDIDATE
// ======================================================

socket.on(
    "ice-candidate",
    async ({
        senderId,
        candidate
    }) => {

        if (!peerConnection) {
            return;
        }


        try {

            await peerConnection.addIceCandidate(
                new RTCIceCandidate(
                    candidate
                )
            );


        } catch (error) {

            console.error(
                "ICE error:",
                error
            );

        }

    }
);


// ======================================================
// CAMERA LEFT
// ======================================================

socket.on(
    "camera-left",
    () => {

        statusText.textContent =
            "⚠️ Camera is offline";


        if (peerConnection) {

            peerConnection.close();

            peerConnection =
                null;

        }


        remoteVideo.srcObject =
            null;

    }
);


// ======================================================
// VIEWER COUNT
// ======================================================

socket.on(
    "viewer-count",
    (count) => {

        viewerCountText.textContent =
            `Viewers: ${count}`;

    }
);


// ======================================================
// SERVER DISCONNECTED
// ======================================================

socket.on(
    "disconnect",
    () => {

        statusText.textContent =
            "⚠️ Server disconnected";

    }
);


// ======================================================
// PAGE CLOSE
// ======================================================

window.addEventListener(
    "beforeunload",
    () => {

        if (peerConnection) {

            peerConnection.close();

        }

    }
);
