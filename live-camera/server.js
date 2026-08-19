const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ======================================================
// GOOGLE DRIVE AUTHENTICATION
// ======================================================

function getDrive() {
  const credential = process.env.GOOGLE_FILE_CREDENTIAL;

  if (!credential) {
    throw new Error(
      "Google Drive credentials are not configured."
    );
  }

  let credentials;

  try {
    credentials = JSON.parse(credential);
  } catch (error) {
    console.error(
      "GOOGLE_FILE_CREDENTIAL contains invalid JSON."
    );

    throw new Error(
      "GOOGLE_FILE_CREDENTIAL is not valid JSON."
    );
  }

  if (
    !credentials.client_email ||
    !credentials.private_key ||
    !credentials.project_id
  ) {
    throw new Error(
      "Google service-account JSON is missing required fields."
    );
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key.replace(/\\n/g, "\n"),
    scopes: [
      "https://www.googleapis.com/auth/drive"
    ]
  });

  return google.drive({
    version: "v3",
    auth
  });
}

// ======================================================
// SAFE FILE NAME
// ======================================================

function safeName(name) {
  return String(name || "recording.webm")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .slice(0, 180);
}

// ======================================================
// CREATE GOOGLE DRIVE RESUMABLE UPLOAD SESSION
// ======================================================

app.post("/api/drive/session", async (req, res) => {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!folderId) {
      return res.status(500).json({
        error:
          "GOOGLE_DRIVE_FOLDER_ID is not configured."
      });
    }

    const drive = getDrive();

    const auth = drive.context._options.auth;

    const tokenResponse = await auth.getAccessToken();

    const token =
      typeof tokenResponse === "string"
        ? tokenResponse
        : tokenResponse.token;

    if (!token) {
      throw new Error(
        "Could not obtain Google Drive access token."
      );
    }

    const mime =
      req.body.mimeType || "video/webm";

    const metadata = {
      name: safeName(req.body.fileName),
      parents: [folderId],
      mimeType: mime
    };

    const response = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type":
            "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mime
        },

        body: JSON.stringify(metadata)
      }
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `Drive session failed: ${response.status} ${text}`
      );
    }

    const uploadUrl =
      response.headers.get("location");

    if (!uploadUrl) {
      throw new Error(
        "Google Drive did not return an upload URL."
      );
    }

    console.log(
      "Google Drive upload session created."
    );

    res.json({
      uploadUrl
    });

  } catch (error) {
    console.error(
      "Google Drive session error:",
      error
    );

    res.status(500).json({
      error: error.message
    });
  }
});

// ======================================================
// DELETE RECORDINGS OLDER THAN 30 DAYS
// ======================================================

app.post("/api/cleanup", async (req, res) => {
  try {
    const cleanupToken =
      process.env.CLEANUP_TOKEN;

    if (
      !cleanupToken ||
      req.headers.authorization !==
        `Bearer ${cleanupToken}`
    ) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const folderId =
      process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!folderId) {
      return res.status(500).json({
        error:
          "GOOGLE_DRIVE_FOLDER_ID is not configured."
      });
    }

    const drive = getDrive();

    const cutoff = new Date(
      Date.now() -
        30 *
          24 *
          60 *
          60 *
          1000
    ).toISOString();

    let deleted = 0;
    let pageToken;

    do {
      const result =
        await drive.files.list({
          q:
            `'${folderId}' in parents ` +
            `and trashed = false ` +
            `and createdTime < '${cutoff}'`,

          fields:
            "nextPageToken, files(id,name,createdTime)",

          pageSize: 1000,

          pageToken
        });

      for (
        const file of result.data.files || []
      ) {
        console.log(
          `Deleting old recording: ${file.name}`
        );

        await drive.files.update({
          fileId: file.id,

          requestBody: {
            trashed: true
          }
        });

        deleted++;
      }

      pageToken =
        result.data.nextPageToken;

    } while (pageToken);

    res.json({
      ok: true,
      deleted
    });

  } catch (error) {
    console.error(
      "Cleanup error:",
      error
    );

    res.status(500).json({
      error: error.message
    });
  }
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,

    googleDriveConfigured:
      !!process.env.GOOGLE_FILE_CREDENTIAL,

    folderConfigured:
      !!process.env.GOOGLE_DRIVE_FOLDER_ID
  });
});

// ======================================================
// SOCKET.IO LIVE CAMERA
// ======================================================

io.on("connection", (socket) => {

  socket.on("join-room", (roomId) => {

    socket.join(roomId);

    const room =
      io.sockets.adapter.rooms.get(roomId);

    const users =
      room ? room.size : 0;

    socket.emit(
      "role",
      users === 1
        ? "camera"
        : "viewer"
    );

    socket.to(roomId).emit(
      "user-joined"
    );
  });

  socket.on(
    "offer",
    ({ roomId, offer }) => {
      socket
        .to(roomId)
        .emit("offer", offer);
    }
  );

  socket.on(
    "answer",
    ({ roomId, answer }) => {
      socket
        .to(roomId)
        .emit("answer", answer);
    }
  );

  socket.on(
    "ice-candidate",
    ({ roomId, candidate }) => {
      socket
        .to(roomId)
        .emit(
          "ice-candidate",
          candidate
        );
    }
  );
});

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `Google Drive credential configured: ${
      !!process.env.GOOGLE_FILE_CREDENTIAL
    }`
  );

  console.log(
    `Google Drive folder configured: ${
      !!process.env.GOOGLE_DRIVE_FOLDER_ID
    }`
  );
});
