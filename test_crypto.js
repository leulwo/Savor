const crypto = require("crypto");
const email = "test@example.com";
const hash = crypto.createHash("md5").update(email.toLowerCase()).digest("hex");
console.log(hash);
