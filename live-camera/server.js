const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

function getDrive() {
  const email=process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key=process.env.GOOGLE_PRIVATE_KEY;
  if(!email||!key) throw new Error("Google Drive credentials are not configured.");
  const auth=new google.auth.JWT({
    email,
    key:key.replace(/\\n/g,"\n"),
    scopes:["https://www.googleapis.com/auth/drive"]
  });
  return google.drive({version:"v3",auth});
}

function safeName(name) {
  return String(name||"recording.webm").replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,180);
}

app.post("/api/drive/session",async(req,res)=>{
  try {
    const folderId=process.env.GOOGLE_DRIVE_FOLDER_ID;
    if(!folderId) return res.status(500).json({error:"GOOGLE_DRIVE_FOLDER_ID is not configured."});
    const drive=getDrive();
    const auth=drive.context._options.auth;
    const tokenResponse=await auth.getAccessToken();
    const token=typeof tokenResponse==="string"?tokenResponse:tokenResponse.token;
    const mime=req.body.mimeType||"video/webm";
    const metadata={name:safeName(req.body.fileName),parents:[folderId],mimeType:mime};
    const r=await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",{
      method:"POST",
      headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/json; charset=UTF-8",
        "X-Upload-Content-Type":mime
      },
      body:JSON.stringify(metadata)
    });
    if(!r.ok) throw new Error(`Drive session failed: ${r.status} ${await r.text()}`);
    const uploadUrl=r.headers.get("location");
    if(!uploadUrl) throw new Error("Drive did not return an upload URL.");
    res.json({uploadUrl});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

app.post("/api/cleanup",async(req,res)=>{
  try {
    const token=process.env.CLEANUP_TOKEN;
    if(!token||req.headers.authorization!==`Bearer ${token}`) return res.status(401).json({error:"Unauthorized"});
    const folderId=process.env.GOOGLE_DRIVE_FOLDER_ID;
    if(!folderId) return res.status(500).json({error:"Folder ID not configured."});
    const drive=getDrive();
    const cutoff=new Date(Date.now()-30*24*60*60*1000).toISOString();
    let deleted=0,pageToken;
    do {
      const result=await drive.files.list({
        q:`'${folderId}' in parents and trashed = false and createdTime < '${cutoff}'`,
        fields:"nextPageToken, files(id,name,createdTime)",
        pageSize:1000,pageToken
      });
      for(const file of result.data.files||[]) {
        await drive.files.update({fileId:file.id,requestBody:{trashed:true}});
        deleted++;
      }
      pageToken=result.data.nextPageToken;
    } while(pageToken);
    res.json({ok:true,deleted});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

app.get("/health",(req,res)=>res.json({ok:true}));

io.on("connection",socket=>{
  socket.on("join-room",roomId=>{
    socket.join(roomId);
    const room=io.sockets.adapter.rooms.get(roomId);
    const users=room?room.size:0;
    socket.emit("role",users===1?"camera":"viewer");
    socket.to(roomId).emit("user-joined");
  });
  socket.on("offer",({roomId,offer})=>socket.to(roomId).emit("offer",offer));
  socket.on("answer",({roomId,answer})=>socket.to(roomId).emit("answer",answer));
  socket.on("ice-candidate",({roomId,candidate})=>socket.to(roomId).emit("ice-candidate",candidate));
});

server.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
