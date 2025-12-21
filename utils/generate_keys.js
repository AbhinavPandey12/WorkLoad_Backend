import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const vapidKeys = webpush.generateVAPIDKeys();
fs.writeFileSync(path.join(__dirname, 'keys.txt'), `PUBLIC_KEY=${vapidKeys.publicKey}\nPRIVATE_KEY=${vapidKeys.privateKey}`);
