const express = require("express");
const router = express.Router();
const { execSync } = require("child_process");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const imap = require("imap-simple");
const Mail = require("../Models/Mail");
const nodemailer = require("nodemailer");
const quotedPrintable = require("quoted-printable");
const Imap = require('node-imap');
const { simpleParser } = require("mailparser");
const mailcomposer = require("mailcomposer");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "super_secret"; // set this securely!


const folderMap = {
  inbox: "INBOX",
  sent: "Sent",
  drafts: "Drafts",
  trash: "Trash",
  archived: "Archive",
  star: "INBOX",
  social: "INBOX",
  promotions: "INBOX",
};


router.post("/create-email-user", async (req, res) => {
  try {
    const { email, password } = req.body; // Accept email, not username
    if (!email || !password)
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });

    // Validate domain
    const match = email.match(/^([a-zA-Z0-9._-]+)@sharda\.co\.in$/);
    if (!match)
      return res
        .status(400)
        .json({ success: false, message: "Invalid email domain." });

    const username = match[1];
    const domain = "sharda.co.in";
    const mailDirBase = `/home/user-data/mail/mailboxes/${domain}/${username}`;
    const mailDir = `${mailDirBase}/Maildir`;

    // 1. Create maildir and set permissions
    execSync(`sudo mkdir -p ${mailDir}`);
    execSync(`sudo chown -R mail:mail ${mailDirBase}`);
    execSync(`sudo chmod -R 700 ${mailDirBase}`);

    // 2. Generate hashed password with doveadm
    const hashed = execSync(`sudo doveadm pw -s SHA512-CRYPT -p '${password}'`)
      .toString()
      .trim();

    // 3. Append to /etc/dovecot/users
    const dovecotUserLine = `${email}:${hashed}:::userdb_mail=maildir:/home/user-data/mail/mailboxes/${domain}/${username}/Maildir`;
    fs.appendFileSync("/etc/dovecot/users", dovecotUserLine + "\n");

    // 4. Insert into SQLite
    const db = new sqlite3.Database("/home/user-data/mail/users.sqlite");
    db.run(
      "INSERT INTO users (email, password, privileges) VALUES (?, ?, ?)",
      [`${username}@${domain}`, password, "user"],
      function (err) {
        db.close();
        if (err)
          return res.status(500).json({ success: false, error: err.message });
        return res.json({
          success: true,
          message: "Mail user created successfully!",
        });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/list-email-users", (req, res) => {
  try {
    const data = fs.readFileSync("/etc/dovecot/users", "utf8");
    const users = data
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const email = line.split(":")[0];
        return { email };
      });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: "Failed to read users." });
  }
});

router.delete("/delete-email-user", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email required" });

    // Extract username & domain
    const match = email.match(/^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+)$/);
    if (!match)
      return res.status(400).json({ success: false, message: "Invalid email" });
    const username = match[1];
    const domain = match[2];

    // 1. Remove from dovecot users file
    const usersPath = "/etc/dovecot/users";
    let usersFile = fs
      .readFileSync(usersPath, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith(email + ":"))
      .join("\n");
    fs.writeFileSync(usersPath, usersFile + "\n");

    // 2. Remove mailbox directory
    const maildir = `/home/user-data/mail/mailboxes/${domain}/${username}`;
    execSync(`sudo rm -rf ${maildir}`);

    // 3. Remove from sqlite
    const db = new sqlite3.Database("/home/user-data/mail/users.sqlite");
    db.run("DELETE FROM users WHERE email = ?", [email], function (err) {
      db.close();
      if (err)
        return res.status(500).json({ success: false, error: err.message });
      return res.json({ success: true, message: "User deleted" });
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/reset-email-password", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });

    // Generate hashed password using doveadm
    const hashed = execSync(`sudo doveadm pw -s SHA512-CRYPT -p '${password}'`)
      .toString()
      .trim();

    // Update /etc/dovecot/users
    const usersPath = "/etc/dovecot/users";
    let lines = fs.readFileSync(usersPath, "utf8").split("\n");
    let updated = false;
    lines = lines.map((line) => {
      if (line.startsWith(email + ":")) {
        updated = true;
        // Extract maildir path if present, else reconstruct
        const maildir =
          line.split("userdb_mail=")[1] ||
          `maildir:/home/user-data/mail/mailboxes/sharda.co.in/${email.split("@")[0]
          }/Maildir`;
        return `${email}:${hashed}:::userdb_mail=${maildir}`;
      }
      return line;
    });
    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    fs.writeFileSync(usersPath, lines.join("\n").replace(/\n+$/, "\n")); // preserve trailing newline

    // Update password in SQLite
    const db = new sqlite3.Database("/home/user-data/mail/users.sqlite");
    db.run(
      "UPDATE users SET password = ? WHERE email = ?",
      [password, email],
      function (err) {
        db.close();
        if (err)
          return res.status(500).json({ success: false, error: err.message });
        return res.json({
          success: true,
          message: "Password updated successfully!",
        });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// router.post("/login", async (req, res) => {
//   const { email, password } = req.body;
//   if (!email || !password)
//     return res
//       .status(400)
//       .json({ success: false, message: "Email and password are required" });

//   const config = {
//     imap: {
//       user: email, // try both "sauser@sharda.co.in" and "sauser"
//       password,
//       host: "mail.sharda.co.in",
//       port: 993,
//       tls: true,
//       authTimeout: 5000,
//       tlsOptions: { rejectUnauthorized: false },
//       authTimeout: 5000,
//       debug: console.log,
//     },
//   };

//   try {
//     const connection = await imap.connect(config);
//     await connection.end();
//     // Success!
//     return res.json({ success: true, message: "Login successful!" });
//   } catch (err) {
//     // Login failed
//     return res
//       .status(401)
//       .json({ success: false, message: "Invalid email or password." });
//   }
// });

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res
      .status(400)
      .json({ success: false, message: "Email and password are required" });

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
      authTimeout: 5000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.end();
    // ✅ Set role dynamically for admin
    const isAdmin = email.trim().toLowerCase() === "admin@sharda.co.in";
    const token = jwt.sign(
      { email, role: isAdmin ? "admin" : "user" },
      JWT_SECRET
    );

    return res.json({
      success: true,
      message: "Login successful!",
      token,
    });
  } catch (err) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid email or password." });
  }
});


// router.get("/get-mails", async (req, res) => {
//   const {
//     email,
//     password,
//     folder = "INBOX",
//     page = 1,
//     pageSize = 20,
//   } = req.query;

//   if (!email || !password)
//     return res
//       .status(400)
//       .json({ success: false, message: "Email and password required" });

//   const folderMap = {
//     inbox: "INBOX",
//     sent: "Sent",
//     drafts: "Drafts",
//     trash: "Trash",
//     archived: "Archive",
//     star: "INBOX",
//     social: "INBOX",
//     promotions: "INBOX",
//   };

//   let targetFolder = folderMap[folder.toLowerCase()] || folder;

//   const config = {
//     imap: {
//       user: email,
//       password,
//       host: "mail.sharda.co.in",
//       port: 993,
//       tls: true,
//       authTimeout: 5000,
//       tlsOptions: { rejectUnauthorized: false },
//     },
//   };

//   try {
//     const connection = await imap.connect(config);

//     await connection.openBox(targetFolder);

//     const totalMessages = await connection.search(["ALL"], {
//       bodies: ["HEADER"],
//       struct: true,
//     });
//     const total = totalMessages.length;
//     const start = Math.max(total - page * pageSize, 0) + 1;
//     const end = total - (page - 1) * pageSize;

//     if (total === 0) {
//       await connection.end();
//       return res.json({ success: true, emails: [], total: 0 });
//     }

//     const messages = await connection.search([`${start}:${end}`], {
//       bodies: ["HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE)", "TEXT"],

//       struct: true,
//       markSeen: false,
//     });

//     const emails = await Promise.all(
//       messages.map(async (msg) => {
//         // Find the full raw email (RFC822 part)
//         const rfc822 = msg.parts.find(
//           (part) => part.which === "TEXT" || part.which === "RFC822"
//         );
//         let raw = "";

//         if (rfc822 && rfc822.body) {
//           raw = rfc822.body.toString();
//         }

//         // Parse using mailparser (if you only have "TEXT", try fetching "RFC822" in your search!)
//         let parsed = {};
//         if (raw) {
//           parsed = await simpleParser(raw);
//         }

//         // Fallback for missing fields
//         const all = msg.parts.find(
//           (part) => part.which === "HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE)"
//         );

//         const subject =
//           all && all.body.subject
//             ? all.body.subject[0]
//             : parsed.subject || "(No Subject)";
//         const from =
//           all && all.body.from ? all.body.from[0] : parsed.from?.text || "";
//         const to = all && all.body.to ? all.body.to[0] : parsed.to?.text || "";
//         const cc = all && all.body.cc ? all.body.cc[0] : parsed.cc?.text || "";
//         const bcc =
//           all && all.body.bcc ? all.body.bcc[0] : parsed.bcc?.text || "";
//         const date =
//           all && all.body.date ? all.body.date[0] : parsed.date || "";

//         return {
//           uid: msg.attributes.uid,
//           subject,
//           from,
//           to,
//           cc,
//           bcc,
//           date,
//           body: parsed.html || parsed.text || "",
//           text: parsed.text || "",
//           attachments: (parsed.attachments || []).map((att, idx) => ({
//             filename: att.filename,
//             contentType: att.contentType,
//             size: att.size,
//             index: idx, // <--- this is important!
//             // We'll use this for download endpoint
//           })),
//         };
//       })
//     );
//     await connection.end();
//     return res.json({ success: true, emails, total });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });

router.get("/get-mails", async (req, res) => {
  const {
    email,
    password,
    folder = "INBOX",
    page = 1,
    pageSize = 20,
  } = req.query;

  if (!email || !password)
    return res
      .status(400)
      .json({ success: false, message: "Email and password required" });

  const folderMap = {
    inbox: "INBOX",
    sent: "Sent",
    drafts: "Drafts",
    trash: "Trash",
    archived: "Archive",
    star: "INBOX",
    social: "INBOX",
    promotions: "INBOX",
  };

  let targetFolder = folderMap[folder.toLowerCase()] || folder;

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
      authTimeout: 5000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };
  let connection;
  try {
    const connection = await require("imap-simple").connect(config);
    await connection.openBox(targetFolder);

    // Get all UIDs and sort/page them
    const searchResults = await connection.search(['ALL'], { bodies: [], struct: true });
    const total = searchResults.length;
    const pageSizeNum = parseInt(pageSize);
    const pageNum = parseInt(page);

    if (total === 0) {
      await connection.end();
      return res.json({ success: true, emails: [], total: 0 });
    }

    // REVERSE array to get most recent mails first
    searchResults.reverse();

    // Properly page: page=1 is newest N, page=2 is next N, etc.
    const paged = searchResults.slice((pageNum - 1) * pageSizeNum, pageNum * pageSizeNum);
    const uids = paged.map(msg => ({
      uid: msg.attributes.uid,
      flags: msg.attributes.flags || [],
    }));

    const emails = await Promise.all(
      uids.map(async ({ uid, flags }) => { // destructure here!
        return new Promise((resolve, reject) => {
          const fetcher = connection.imap.fetch(uid, {
            bodies: '',
            struct: true
          });
          let raw = '';
          fetcher.on('message', (msg) => {
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => {
                raw += chunk.toString('utf8');
              });
              stream.once('end', async () => {
                try {
                  const parsed = await require('mailparser').simpleParser(raw);
                  resolve({
                    uid,
                    subject: parsed.subject || '(No Subject)',
                    from: parsed.from?.text || '',
                    to: parsed.to?.text || '',
                    cc: parsed.cc?.text || '',
                    bcc: parsed.bcc?.text || '',
                    date: parsed.date || '',
                    body: parsed.html || parsed.text || '',
                    text: parsed.text || '',
                    attachments: (parsed.attachments || []).map((att, idx) => ({
                      filename: att.filename || `attachment-${idx}`,
                      contentType: att.contentType,
                      size: att.size,
                      content: att.content.toString('base64'),
                      index: idx,
                    })),
                    read: Array.isArray(flags) && flags.includes('\\Seen'),
                    flags, // (optional, for debugging)
                  });
                } catch (err) {
                  reject(err);
                }
              });
            });
            msg.once('error', reject);
          });
          fetcher.once('error', reject);
        });
      })
    );

    await connection.end();
    return res.json({ success: true, emails, total });

  } catch (err) {
    console.error(err);
    if (connection) await connection.end();
    return res.status(500).json({ success: false, error: err.message });
  }
});


router.get("/get-attachment", async (req, res) => {
  const { email, password, uid, folder = "INBOX", index } = req.query;
  if (!email || !password || !uid || index === undefined)
    return res
      .status(400)
      .json({ success: false, message: "Missing parameters" });

  // Use the folderMap to resolve the IMAP box name
  const box =
    folderMap[(folder || "INBOX").toLowerCase()] || (folder || "INBOX");

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
      authTimeout: 5000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  let connection;
  try {
    connection = await imap.connect(config);
    await connection.openBox(box);

    console.log("get-attachment params:", { email, box, uid, index });

    // IMAP expects UID as a string in an array for imap-simple:
    const allMessages = await connection.search(['ALL'], { bodies: [''], struct: true });
    const message = allMessages.find(msg => msg.attributes.uid == uid);

    // console.log("messages found:", message.length);

    if (!message) {
      // List all UIDs for debugging
      const allUIDs = allMessages.map(m => m.attributes.uid);
      console.log('All UIDs in folder (ALL):', allUIDs);
      await connection.end();
      return res.status(404).json({ success: false, message: "Mail not found" });
    }


    // Raw RFC822 body is in parts[0].body (for imap-simple)
    const raw = message.parts[0].body;
    const parsed = await simpleParser(raw);

    const att = (parsed.attachments || [])[parseInt(index)];
    if (!att) {
      await connection.end();
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    res.setHeader(
      "Content-Type",
      att.contentType || "application/octet-stream"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${att.filename}"`
    );
    res.send(att.content);

    await connection.end();
  } catch (err) {
    if (connection) await connection.end();
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


router.post("/:uid/junk", async (req, res) => {
  const { uid } = req.params;
  try {
    const result = await Mail.updateOne({ uid }, { $set: { folder: "junk" } });
    if (result.nModified === 0)
      return res.status(404).json({ error: "Mail not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:uid/archive", async (req, res) => {
  const { uid } = req.params;
  const { email, password, currentFolder } = req.body; // IMAP login details required!

  // 1. Connect to IMAP
  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder); // Archive only from INBOX
    await connection.moveMessage(uid, "Archive"); // Or "Archived", check your folder name
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:uid/trash", async (req, res) => {
  const { uid } = req.params;
  const { email, password, currentFolder } = req.body; // IMAP login details required!

  // 1. Connect to IMAP
  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder); // Move only from INBOX
    await connection.moveMessage(uid, "Trash"); // .Trash is the folder name from your server
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// router.post("/send", async (req, res) => {
//   const { to, subject, text, from, password } = req.body;

//   try {
//     // 1. Send via SMTP
//     const transporter = nodemailer.createTransport({
//       host: "mail.sharda.co.in",
//       port: 465,
//       secure: true,
//       auth: { user: from, pass: password },
//     });

//     const mailOptions = { from, to, subject, text };
//     const info = await transporter.sendMail(mailOptions);

//     // 2. Prepare raw RFC822 message for IMAP append

//     // 3. IMAP: Append to "Sent"
//     const config = {
//       imap: {
//         user: from,
//         password: password,
//         host: "mail.sharda.co.in",
//         port: 993,
//         tls: true,
//         authTimeout: 10000,
//         tlsOptions: { rejectUnauthorized: false },
//       },
//     };

//     const connection = await imap.connect(config);
//     await connection.openBox("Sent"); // The folder might be 'Sent' or 'Sent Items'

//     // Create a raw mail string for append
//     const rawMail = [
//       `From: ${from}`,
//       `To: ${to}`,
//       `Subject: ${subject}`,
//       "Date: " + new Date().toUTCString(),
//       "", // blank line to separate headers from body
//       text,
//     ].join("\r\n");
//     // Append to Sent (flags and date optional)
//     await connection.append(rawMail, { mailbox: "Sent" });
//     await connection.end();

//     res.json({
//       success: true,
//       message: "Email sent and saved to Sent folder!",
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

router.post("/send", async (req, res) => {
  const {
    to,
    subject,
    text,
    from,
    password,
    cc,
    bcc,
    attachments = [],
  } = req.body;

  try {
    // 1. Create transporter as usual
    const transporter = nodemailer.createTransport({
      host: "mail.sharda.co.in",
      port: 465,
      secure: true,
      auth: { user: from, pass: password },
    });

    // 2. Build mailcomposer object
    const htmlBody = `<div style="color:#222;font-family:Arial,sans-serif;">${text}</div>`;
    const mail = mailcomposer({
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      html: htmlBody,
      attachments: attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
        encoding: att.encoding || "base64",
      })),
    });

    // 3. Build raw RFC822 message
    mail.build(async function (err, message) {
      if (err) return res.status(500).json({ error: err.message });

      // 4. Send via SMTP
      await transporter.sendMail({
        from,
        to,
        cc,
        bcc,
        subject,
        text,
        html: htmlBody,
        attachments: attachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          encoding: att.encoding || "base64",
        })),
      });

      // 5. Save in IMAP "Sent"
      const config = {
        imap: {
          user: from,
          password: password,
          host: "mail.sharda.co.in",
          port: 993,
          tls: true,
          authTimeout: 10000,
          tlsOptions: { rejectUnauthorized: false },
        },
      };
      const connection = await imap.connect(config);
      await connection.openBox("Sent");
      await connection.append(message, { mailbox: "Sent" }); // message is Buffer
      await connection.end();

      res.json({
        success: true,
        message: "Email sent and saved to Sent folder!",
        info: {},
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildRawDraft({ from, to, cc, bcc, subject, text, attachments }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  if (!attachments || attachments.length === 0) {
    // No attachments, just plain text
    headers.push("Content-Type: text/plain; charset=UTF-8", "", text);
    return headers.join("\r\n");
  }

  // With attachments: build multipart MIME message
  const boundary = "----=_Boundary_" + Date.now();
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");

  // Start MIME body
  let body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
  ];

  // Add each attachment
  attachments.forEach((att) => {
    body.push(`--${boundary}`);
    body.push(`Content-Type: application/octet-stream; name="${att.filename}"`);
    body.push("Content-Transfer-Encoding: base64");
    body.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    body.push("");
    body.push(att.content); // assume already base64-encoded
    body.push("");
  });

  // End boundary
  body.push(`--${boundary}--`, "");

  return headers.join("\r\n") + "\r\n" + body.join("\r\n");
}



router.post("/save-draft", async (req, res) => {
  const {
    email,
    password,
    to,
    cc,
    bcc,
    subject,
    text,
    attachments = [],
  } = req.body;
  // Validate inputs...

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await Imap.connect(config);
    const draftMessage = buildRawDraft({
      from: email,
      to,
      cc,
      bcc,
      subject,
      text,
      attachments, // array of {filename, content, encoding}
    });

    // Save as draft: IMAP append to "Drafts" folder with \Draft flag
    await connection.append(draftMessage, {
      mailbox: "Drafts",
      flags: ["\\Draft"],
    });

    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not save draft" });
  }
});

router.post("/:uid/unarchive", async (req, res) => {
  const { uid } = req.params;
  const { email, password, currentFolder } = req.body;

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder);
    await connection.moveMessage(uid, "INBOX"); // Move to INBOX
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:uid/restore", async (req, res) => {
  const { uid } = req.params;
  const { email, password, currentFolder } = req.body;

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder); // Usually "Trash"
    await connection.moveMessage(uid, "INBOX"); // Move to INBOX
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:uid/delete", async (req, res) => {
  const { uid } = req.params;
  const { email, password, currentFolder } = req.body;

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder); // Should be "Trash"
    await connection.deleteMessage(uid); // Permanently deletes the message
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:uid/delete-draft", async (req, res) => {
  const { uid } = req.params;
  const { email, password, currentFolder } = req.body;

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder); // Should be "Drafts"
    await connection.deleteMessage(uid);
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:uid/send-draft", async (req, res) => {
  const { uid } = req.params;
  const { email, password, to, subject, text, currentFolder } = req.body;

  // 1. Send the draft using your SMTP send logic (reuse your /send endpoint logic)
  // ... SMTP send logic here ...

  // 2. Delete from Drafts
  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(currentFolder || "Drafts");
    await connection.deleteMessage(uid);
    await connection.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:uid/mark-as-read", async (req, res) => {
  const { uid } = req.params;
  const { email, password, folder = "INBOX" } = req.body;

  if (!email || !password || !uid) {
    return res
      .status(400)
      .json({ success: false, message: "Email, password, and uid are required" });
  }

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
      authTimeout: 5000,
    },
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox(folder);

    // UIDs should be numbers; wrap in array if not already
    await connection.addFlags([Number(uid)], "\\Seen");

    await connection.end();

    res.json({
      success: true,
      message: "Email marked as read successfully!",
    });
  } catch (err) {
    console.error("Mark as read error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


router.get("/folder-stats", async (req, res) => {
  const { email, password, folder = "INBOX" } = req.query;

  if (!email || !password)
    return res
      .status(400)
      .json({ success: false, message: "Email and password required" });

  const folderMap = {
    inbox: "INBOX",
    sent: "Sent",
    drafts: "Drafts",
    trash: "Trash",
    archived: "Archive",
    star: "INBOX",
    social: "INBOX",
    promotions: "INBOX",
  };

  let targetFolder = folderMap[folder.toLowerCase()] || folder;

  const config = {
    imap: {
      user: email,
      password,
      host: "mail.sharda.co.in",
      port: 993,
      tls: true,
      authTimeout: 5000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  let connection;
  try {
    connection = await require("imap-simple").connect(config);
    await connection.openBox(targetFolder);

    // Get all UIDs
    const allMsgs = await connection.search(['ALL'], { bodies: [], struct: true });
    const unseenMsgs = await connection.search(['UNSEEN'], { bodies: [], struct: true });

    await connection.end();

    res.json({
      success: true,
      total: allMsgs.length,
      unread: unseenMsgs.length,
    });
  } catch (err) {
    if (connection) await connection.end();
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
