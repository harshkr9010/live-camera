const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});


// ======================================================
// ROOMS
// ======================================================
//
// Each room has:
// camera: socket ID of the camera
// viewers: Set of viewer socket IDs
//
// The server NEVER receives the camera video.
// It only passes WebRTC signaling messages.
// ======================================================

const rooms = new Map();

function getRoom(roomId) {

    if (!rooms.has(roomId)) {

        rooms.set(roomId, {
            camera: null,
            viewers: new Set()
        });

    }

    return rooms.get(roomId);
}


// ======================================================
// SOCKET CONNECTION
// ======================================================

io.on("connection", (socket) => {

    console.log(
        "Client connected:",
        socket.id
    );


    // ==================================================
    // JOIN ROOM
    // ==================================================

    socket.on("join-room", (roomId) => {

        roomId = String(roomId || "").trim();

        if (!roomId) {
            return;
        }

        // Leave previous room if necessary
        if (socket.data.roomId) {

            leaveRoom(socket);
        }

        socket.data.roomId = roomId;

        const room = getRoom(roomId);


        // ==================================================
        // FIRST DEVICE = CAMERA
        // ==================================================

        if (!room.camera) {

            room.camera = socket.id;

            socket.data.role = "camera";

            socket.join(roomId);

            socket.emit("role", "camera");

            socket.emit(
                "camera-ready",
                {
                    viewers: room.viewers.size
                }
            );

            console.log(
                `Camera ${socket.id} started room ${roomId}`
            );

            return;
        }


        // ==================================================
        // EVERY OTHER DEVICE = VIEWER
        // ==================================================

        socket.data.role = "viewer";

        room.viewers.add(socket.id);

        socket.join(roomId);

        socket.emit("role", "viewer");

        console.log(
            `Viewer ${socket.id} joined room ${roomId}`
        );


        // Tell viewer which camera it should connect to
        socket.emit(
            "camera-available",
            {
                cameraId: room.camera
            }
        );


        // Tell camera that a new viewer arrived
        io.to(room.camera).emit(
            "viewer-joined",
            {
                viewerId: socket.id
            }
        );


        // Update viewer count
        updateViewerCount(roomId);

    });


    // ==================================================
    // CAMERA OFFER -> SPECIFIC VIEWER
    // ==================================================

    socket.on(
        "offer",
        ({ viewerId, offer }) => {

            if (
                socket.data.role !== "camera" ||
                !viewerId ||
                !offer
            ) {
                return;
            }

            io.to(viewerId).emit(
                "offer",
                {
                    cameraId: socket.id,
                    offer
                }
            );
        }
    );


    // ==================================================
    // VIEWER ANSWER -> CAMERA
    // ==================================================

    socket.on(
        "answer",
        ({ cameraId, answer }) => {

            if (
                socket.data.role !== "viewer" ||
                !cameraId ||
                !answer
            ) {
                return;
            }

            io.to(cameraId).emit(
                "answer",
                {
                    viewerId: socket.id,
                    answer
                }
            );
        }
    );


    // ==================================================
    // ICE CANDIDATE
    // ==================================================

    socket.on(
        "ice-candidate",
        ({ targetId, candidate }) => {

            if (
                !targetId ||
                !candidate
            ) {
                return;
            }

            io.to(targetId).emit(
                "ice-candidate",
                {
                    senderId: socket.id,
                    candidate
                }
            );
        }
    );


    // ==================================================
    // DISCONNECT
    // ==================================================

    socket.on("disconnect", () => {

        console.log(
            "Client disconnected:",
            socket.id
        );

        leaveRoom(socket);

    });

});


// ======================================================
// LEAVE ROOM
// ======================================================

function leaveRoom(socket) {

    const roomId =
        socket.data.roomId;

    if (!roomId) {
        return;
    }

    const room =
        rooms.get(roomId);

    if (!room) {
        return;
    }


    // ==================================================
    // CAMERA LEFT
    // ==================================================

    if (
        socket.data.role === "camera" &&
        room.camera === socket.id
    ) {

        room.camera = null;

        // Tell all viewers that camera is gone
        for (
            const viewerId of room.viewers
        ) {

            io.to(viewerId).emit(
                "camera-left"
            );
        }

        console.log(
            `Camera left room ${roomId}`
        );
    }


    // ==================================================
    // VIEWER LEFT
    // ==================================================

    if (
        socket.data.role === "viewer"
    ) {

        room.viewers.delete(
            socket.id
        );


        // Tell camera this viewer is gone
        if (room.camera) {

            io.to(room.camera).emit(
                "viewer-left",
                {
                    viewerId: socket.id
                }
            );
        }

        console.log(
            `Viewer left room ${roomId}`
        );
    }


    socket.leave(roomId);

    socket.data.roomId = null;
    socket.data.role = null;


    updateViewerCount(roomId);


    // Remove empty room
    if (
        !room.camera &&
        room.viewers.size === 0
    ) {

        rooms.delete(roomId);

        console.log(
            `Room deleted: ${roomId}`
        );
    }

}


// ======================================================
// VIEWER COUNT
// ======================================================

function updateViewerCount(roomId) {

    const room =
        rooms.get(roomId);

    if (!room) {
        return;
    }

    const count =
        room.viewers.size;


    if (room.camera) {

        io.to(room.camera).emit(
            "viewer-count",
            count
        );
    }


    for (
        const viewerId of room.viewers
    ) {

        io.to(viewerId).emit(
            "viewer-count",
            count
        );
    }

}


// ======================================================
// HEALTH
// ======================================================

app.get("/health", (req, res) => {

    res.json({
        ok: true,
        streaming: true,
        recording: false,
        storage: false
    });

});


// ======================================================
// START
// ======================================================

server.listen(
    PORT,
    () => {

        console.log(
            `Live camera server running on port ${PORT}`
        );

        console.log(
            "Video recording: DISABLED"
        );

        console.log(
            "Google Drive: DISABLED"
        );

        console.log(
            "Video storage: DISABLED"
        );

    }
);
