#!/usr/bin/env node

import { install } from './install.js';
import { uninstall } from './uninstall.js';
import { doctor } from './doctor.js';

const command = process.argv[2];

if (command === 'install') {
  install();
} else if (command === 'uninstall') {
  uninstall();
} else if (command === 'doctor') {
  doctor();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: idlehands <install|uninstall|doctor>');
  process.exit(1);
}
