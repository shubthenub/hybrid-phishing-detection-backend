import crypto from "crypto";

export const extractIoc = (emailText, sender = "") => {
  const urls = emailText.match(/https?:\/\/[^\s<>"'()]+/g) || [];
  const domain = sender.includes("@") 
    ? sender.split("@")[1].toLowerCase().trim() 
    : "";
  
  const iocString = `${domain}|${urls[0] || ""}`;
  const iocHash = crypto.createHash("sha256").update(iocString).digest("hex");
  
  return { iocHash, iocString, urls, senderDomain: domain };
};

export const cleanEmailText = (text) => {
  let cleaned = text.replace(/<[^>]*>/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 512);
};
