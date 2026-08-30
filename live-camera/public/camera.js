const socket = io();

let roomId = "";
let localStream = null;

const peerConnections = new Map();

let cameraStarted = false;


// ======================================================
// HTML
// ======================================================

const startButton =
    document.getElementById("startButton");

const roomInput =
    document.getElementById("roomId");

const localVideo =
    document.getElementById("localVideo");

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
// START CAMERA
// ======================================================

startButton.addEventListener(
    "click",
    startCamera
);


async function startCamera() {

    if (cameraStarted) {
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


    startButton.disabled = true;

    roomInput.disabled = true;


    try {

        statusText.textContent =
            "Requesting camera and microphone...";


        // ==================================================
        // CAMERA + MICROPHONE
        // ==================================================

        localStream =
            await navigator
                .mediaDevices
                .getUserMedia({

                    video: {
                        facingMode: "environment"
                    },

                    audio: true

                });


        localVideo.srcObject =
            localStream;


        cameraStarted = true;


        // ==================================================
        // JOIN ROOM
        // ==================================================

        socket.emit(
            "join-room",
            roomId
        );


        statusText.textContent =
            "🟢 Camera online — waiting for viewers";


        startButton.textContent =
            "Camera Running";


    } catch (error) {

        console.error(
            "Camera error:",
            error
        );


        statusText.textContent =
            "❌ Camera could not start";


        alert(
            error.message ||
            "Could not access the camera or microphone."
        );


        startButton.disabled =
            false;

        roomInput.disabled =
            false;
    }

}


// ======================================================
// CAMERA ROLE
// ======================================================

socket.on(
    "role",
    (role) => {

        if (role === "camera") {

            statusText.textContent =
                "🟢 Camera LIVE — waiting for viewers";

        }

    }
);


// ======================================================
// NEW VIEWER
// ======================================================

socket.on(
    "viewer-joined",
    async ({ viewerId }) => {

        if (!localStream) {
            return;
        }


        console.log(
            "New viewer:",
            viewerId
        );


        try {

            await createConnectionForViewer(
                viewerId
            );

        } catch (error) {

            console.error(
                "Could not create viewer connection:",
                error
            );

        }

    }
);


// ======================================================
// CREATE CONNECTION FOR ONE VIEWER
// ======================================================

async function createConnectionForViewer(
    viewerId
) {

    // Close old connection if one exists
    closeViewerConnection(viewerId);


    const peerConnection =
        new RTCPeerConnection(
            configuration
        );


    peerConnections.set(
        viewerId,
        peerConnection
    );


    // ==================================================
    // SEND CAMERA TRACKS
    // ==================================================

    localStream
        .getTracks()
        .forEach(
            (track) => {

                peerConnection.addTrack(
                    track,
                    localStream
                );

            }
        );


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
                            viewerId,

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
                `Viewer ${viewerId} connection:`,
                peerConnection.connectionState
            );


            if (
                peerConnection.connectionState ===
                    "connected"
            ) {

                statusText.textContent =
                    "🔴 LIVE";

            }


            if (
                peerConnection.connectionState ===
                    "failed" ||
                peerConnection.connectionState ===
                    "closed" ||
                peerConnection.connectionState ===
                    "disconnected"
            ) {

                console.log(
                    "Viewer connection ended:",
                    viewerId
                );

            }

        };


    // ==================================================
    // CREATE OFFER
    // ==================================================

    const offer =
        await peerConnection.createOffer();


    await peerConnection.setLocalDescription(
        offer
    );


    socket.emit(
        "offer",
        {
            viewerId,
            offer
        }
    );


    console.log(
        "Offer sent to viewer:",
        viewerId
    );

}


// ======================================================
// RECEIVE ANSWER
// ======================================================

socket.on(
    "answer",
    async ({ viewerId, answer }) => {

        const peerConnection =
            peerConnections.get(
                viewerId
            );


        if (!peerConnection) {
            return;
        }


        try {

            await peerConnection.setRemoteDescription(
                new RTCSessionDescription(
                    answer
                )
            );


            console.log(
                "Answer received from:",
                viewerId
            );


        } catch (error) {

            console.error(
                "Answer error:",
                error
            );

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

        const peerConnection =
            peerConnections.get(
                senderId
            );


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
// VIEWER LEFT
// ======================================================

socket.on(
    "viewer-left",
    ({ viewerId }) => {

        console.log(
            "Viewer left:",
            viewerId
        );


        closeViewerConnection(
            viewerId
        );

    }
);


// ======================================================
// CLOSE VIEWER CONNECTION
// ======================================================

function closeViewerConnection(
    viewerId
) {

    const connection =
        peerConnections.get(
            viewerId
        );


    if (connection) {

        connection.close();

        peerConnections.delete(
            viewerId
        );

    }

}


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
// CAMERA LEFT / DISCONNECTED
// ======================================================

socket.on(
    "disconnect",
    () => {

        statusText.textContent =
            "⚠️ Signaling server disconnected";

    }
);


// ======================================================
// PAGE CLOSE
// ======================================================

window.addEventListener(
    "beforeunload",
    () => {

        for (
            const connection
            of peerConnections.values()
        ) {

            connection.close();

        }


        peerConnections.clear();


        if (localStream) {

            localStream
                .getTracks()
                .forEach(
                    track =>
                        track.stop()
                );

        }

    }
);
