import { spawn } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const site = process.argv[2] || 'default';
const envFile = path.join(__dirname, '..', `.env.${site}`);

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
  console.log(`Loaded environment from ${envFile}`);
  console.log(`loadEnv site ${site}`);
} else {
  console.warn(`Warning: ${envFile} not found. Using default .env`);
  dotenv.config();
}

// Change directory to web folder
process.chdir(path.join(__dirname, '..', 'web'));

// Run next dev from the web directory, using its own node_modules
const nextDev = spawn('next', ['dev', '--webpack', '-p', '3000'], {
  stdio: 'inherit',
  env: process.env, // Use web's own dependencies
});

nextDev.on('error', (err) => {
  console.error('Failed to start Next.js dev server:', err);
});

nextDev.on('close', (code) => {
  console.log(`Next.js dev server exited with code ${code}`);
});
