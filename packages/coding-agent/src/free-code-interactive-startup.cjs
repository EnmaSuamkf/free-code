#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FREE_CODE_CONFIG_DIR = path.join(process.env.HOME, '.free-code');
const SKILLS_DIR = path.join(FREE_CODE_CONFIG_DIR, 'skills');
// Assuming MCPs are also managed as extensions/skills, we'll look in the same directory.
// If they are elsewhere, this path needs to be adjusted.
const MCP_DIR = path.join(FREE_CODE_CONFIG_DIR, 'skills'); 

/**
 * Lists subdirectories in a given directory.
 * These subdirectories are assumed to be the skills/mcps.
 * @param {string} dirPath The directory to scan.
 * @returns {Promise<string[]>} A promise that resolves to an array of directory names.
 */
function listComponents(dirPath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(dirPath)) {
            resolve([]);
            return;
        }
        fs.readdir(dirPath, { withFileTypes: true }, (err, dirents) => {
            if (err) {
                reject(`Failed to read directory ${dirPath}: ${err.message}`);
            } else {
                const componentNames = dirents
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => dirent.name);
                resolve(componentNames);
            }
        });
    });
}

/**
 * Creates an interactive multiselect prompt in the terminal.
 * @param {string} query The question to ask the user.
 * @param {string[]} options The list of choices.
 * @returns {Promise<string[]>} A promise that resolves to an array of selected choices.
 */
function interactiveMultiselect(query, options) {
    return new Promise(resolve => {
        if (options.length === 0) {
            console.log(`No options available for: ${query}`);
            resolve([]);
            return;
        }

        const selected = new Set();
        let cursor = 0;
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const render = () => {
            readline.cursorTo(process.stdout, 0);
            readline.clearScreenDown(process.stdout);
            console.log(query);
            console.log('(Use arrow keys to move, space to select/deselect, enter to confirm)');
            options.forEach((option, index) => {
                const isSelected = selected.has(option);
                const isCursor = index === cursor;
                const prefix = isSelected ? '[x]' : '[ ]';
                const styledOption = isCursor ? `\x1b[7m${option}\x1b[0m` : option; // Inverse video for cursor
                console.log(`${isCursor ? '>' : ' '} ${prefix} ${styledOption}`);
            });
        };

        const onKeyPress = (str, key) => {
            if (key.name === 'up') {
                cursor = (cursor - 1 + options.length) % options.length;
            } else if (key.name === 'down') {
                cursor = (cursor + 1) % options.length;
            } else if (key.name === 'space') {
                const option = options[cursor];
                if (selected.has(option)) {
                    selected.delete(option);
                } else {
                    selected.add(option);
                }
            } else if (key.name === 'enter' || key.name === 'return') {
                process.stdin.removeListener('keypress', onKeyPress);
                rl.close();
                resolve(Array.from(selected));
                return;
            } else if (key.ctrl && key.name === 'c') {
                process.exit();
            }
            render();
        };

        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.on('keypress', onKeyPress);
        render();
    });
}

async function main() {
    try {
        console.log('Discovering available Skills and MCPs...');
        const availableSkills = await listComponents(SKILLS_DIR);
        const availableMcps = await listComponents(MCP_DIR); // Assuming same dir for now

        const selectedSkills = await interactiveMultiselect('Which skills would you like to load?', availableSkills);
        const selectedMcps = await interactiveMultiselect('Which MCPs would you like to load?', availableMcps);

        const skillArgs = selectedSkills.map(skill => ['--skill', path.join(SKILLS_DIR, skill)]).flat();
        const mcpArgs = selectedMcps.map(mcp => ['--extension', path.join(MCP_DIR, mcp)]).flat(); // MCPs are loaded as extensions

        const originalArgs = process.argv.slice(2);
        const finalArgs = [...skillArgs, ...mcpArgs, ...originalArgs];
        
        const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

        console.log('\nLaunching free-code with selected components...\n');

        const freeCodeProcess = spawn(process.execPath, [cliPath, ...finalArgs], {
            stdio: 'inherit'
        });

        freeCodeProcess.on('close', (code) => {
            console.log(`free-code process exited with code ${code}`);
        });

        freeCodeProcess.on('error', (err) => {
            console.error('Failed to start free-code process:', err);
        });

    } catch (error) {
        console.error('An error occurred:', error);
        process.exit(1);
    }
}

main();
