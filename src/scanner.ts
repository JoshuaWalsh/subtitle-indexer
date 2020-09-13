import * as crypto from 'crypto';
import { promises as fs, createReadStream } from 'fs';
import * as path from 'path';
import { Stream } from 'stream';
import { demand } from 'ts-demand';
import { default as ffprobe } from 'ffprobe';
import { path as ffprobeStatic } from 'ffprobe-static';
import { Converter as FFMPEG } from 'ffmpeg-stream';
import { default as ffmpegStatic } from 'ffmpeg-static';
import { parse as parseAss, ParsedASSEvent } from 'ass-compiler';

import { db } from './initialiseDb';
import { Conversation, Existing, Library, LibraryFile, Line, Track } from './model';

const libraryRoot = process.env.ROOT_DIRECTORY || ".";
const conversationMaxPauseTime = 1.5;

process.env.FFMPEG_PATH = ffmpegStatic;
const ffprobeOptions: ffprobe.Options = { path: ffprobeStatic };

export async function performScans() {
    if(process.env.DEFAULT_LIBRARIES || process.env.NONDEFAULT_LIBRARIES) {
        const defaultLibraries = (process.env.DEFAULT_LIBRARIES || "").split(",").filter(l => l.length > 0);
        const nondefaultLibraries = (process.env.NONDEFAULT_LIBRARIES || "").split(",").filter(l => l.length > 0);
        const allLibraries = [...defaultLibraries, ...nondefaultLibraries];

        const existingLibraries = db.query<Existing<Library>>("SELECT * FROM libraries");
        for(const existingLibrary of existingLibraries) {
            if(allLibraries.indexOf(existingLibrary.path) === -1) {
                db.delete('libraries', {
                    id: existingLibrary.id,
                });
            }
        }

        for(const libraryPath of defaultLibraries) {
            try {
                db.insert('libraries', demand<Library>({
                    path: libraryPath,
                    searchByDefault: 1,
                    stillExists: 1
                }));
            } catch (err) {
                // Already exists
            }
        }

        for(const libraryPath of nondefaultLibraries) {
            try {
                db.insert('libraries', demand<Library>({
                    path: libraryPath,
                    searchByDefault: 0,
                    stillExists: 1
                }));
            } catch (err) {
                // Already exists
            }
        }
    }
    else if(!process.env.SKIP_SETUP && !db.queryFirstCell("SELECT value FROM settings WHERE setting=?", 'setupComplete')) {
        console.log("Performing first-time setup. You can disable this with the SKIP_SETUP environment variable, or use DEFAULT_LIBRARIES and NONDEFAULT_LIBRARIES to specify comma-separated lists of library locations.");
        await scanForDefaultLibraries();
    }

    await checkLibraryExistence();
    await scanFiles();
    await indexFiles();
}

export async function scanForDefaultLibraries() {
    const rootNodes = await fs.readdir(libraryRoot, {withFileTypes: true}).catch(err => {
        throw new Error(`Failed to scan for libraries, received error code ${err.code} while scanning ${libraryRoot}`);
    });
    const folders = rootNodes.filter(n => n.isDirectory());
    folders.forEach(f => {
        try {
            db.insert('libraries', {
                path: f.name,
                searchByDefault: 1,
                stillExists: 1,
            });
        } catch (err) {
            // Already exists
        }
    });
}

export async function checkLibraryExistence() {
    const libraries = db.query<Existing<Library>>("SELECT id, path, stillExists FROM libraries");

    await Promise.all(libraries.map(async library => {
        const libraryPath = path.resolve(libraryRoot, library.path);
        const exists = await fs.stat(libraryPath).then(() => true, () => false) ? 1 : 0;
        if(exists != library.stillExists) {
            db.update('libraries', {
                stillExists: exists,
            }, {
                id: library.id,
            });
        }
    }));
}

export async function scanFiles() {
    const libraries = db.query<Existing<Library>>("SELECT * FROM libraries WHERE stillExists");
    for (const library of libraries) {
        const libraryPath = path.resolve(libraryRoot, library.path);
        const files = await getFilesRecursive(libraryPath);
        const existingFiles = await db.query<Existing<LibraryFile>>("SELECT * FROM files WHERE libraryId=?", library.id);

        // Remove files that no longer exist
        for(const existingFile of existingFiles) {
            if(files.indexOf(existingFile.path) === -1) {
                db.update<LibraryFile>('files', {
                    stillExists: 0,
                }, {
                    id: existingFile.id,
                });
            }
        }

        for (const relativePath of files) {
            const fullPath = path.resolve(libraryPath, relativePath);

            try {
                const fileDetails = await fs.stat(fullPath);
                const existingFile = await db.queryFirstRow<Existing<LibraryFile>>("SELECT * FROM files WHERE libraryId=? AND path=?", library.id, relativePath);

                if(!existingFile) {
                    db.insert('files', demand<LibraryFile>({
                        libraryId: library.id,
                        path: relativePath,
                        lastModified: fileDetails.mtimeMs,
                        stillExists: 1,
                        size: fileDetails.size,
                        indexed: 0,
                    }));
                } else {
                    if(!existingFile.stillExists) {
                        db.update<Partial<LibraryFile>>('files', {
                            stillExists: 1
                        }, {
                            id: existingFile.id
                        });
                    }

                    if(existingFile.lastModified !== fileDetails.mtimeMs || existingFile.size !== fileDetails.size) {
                        db.update<Partial<LibraryFile>>('files', {
                            lastModified: fileDetails.mtimeMs,
                            size: fileDetails.size,
                            indexed: 0,
                        }, {
                            id: existingFile.id,
                        })
                    }
                }
            } catch (err) {
                console.warn("Error while scanning file", fullPath, err);
            }
        }
    }
}

async function getFilesRecursive(directory: string): Promise<Array<string>> {
    const children = await fs.readdir(directory, {withFileTypes: true});
    let files = children.filter(c => c.isFile()).map(f => f.name);
    const folders = children.filter(c => c.isDirectory());

    for (const folder of folders) {
        const subFiles = await getFilesRecursive(path.resolve(directory, folder.name));
        const relativePaths = subFiles.map(name => `${folder.name}/${name}`);
        files = files.concat(relativePaths);
    }

    return files;
}

async function getFileHash(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hasher = crypto.createHash('sha1');
        const readStream = createReadStream(path);
        readStream.on('data', chunk => {
            hasher.update(chunk);
        });
        readStream.on('err', err => {
            readStream.close();
            hasher.destroy();
            reject(err);
        });
        readStream.on('end', () => {
            resolve(hasher.digest('base64'));
        });
    });
}

export async function indexFiles() {
    const libraries = db.query<Existing<Library>>("SELECT * FROM libraries WHERE stillExists");
    for (const library of libraries) {
        const unindexed = db.query<Existing<LibraryFile>>("SELECT * FROM files WHERE libraryId=? AND stillExists AND NOT indexed", library.id);

        for (const file of unindexed) {
            await indexFile(library, file);
        }
    }
}

export async function indexFile(library: Existing<Library>, file: Existing<LibraryFile>) {
    // Delete existing data for this file
    db.delete('tracks', {
        fileId: file.id,
    });

    const absolutePath = path.resolve(libraryRoot, library.path, file.path);
    const ffprobeResult = await ffprobe(absolutePath, ffprobeOptions).then(r => r, err => null);

    const streams = ffprobeResult?.streams || [];
    const subtitleStreams = streams.filter(s => s.codec_type as string === 'subtitle');
    for(const stream of subtitleStreams) {
        const track: Track = {
            fileId: file.id,
            trackNumber: stream.index,
            language: stream.tags?.language || null,
            title: (stream.tags as any)?.title || null
        };
        const trackId = db.insert('tracks', track);

        await indexTrack(absolutePath, trackId, stream.index);
    }
    db.update<Partial<LibraryFile>>('files', {
        indexed: 1,
    }, {
        id: file.id,
    });
}

async function indexTrack(path: string, trackId: number, streamIndex: number) {
    const ffmpeg = new FFMPEG();
    
    try {
        let rawAss = "";

        ffmpeg.createInputFromFile(path, {});
        ffmpeg.createOutputStream({
            map: `0:${streamIndex}`,
            f: 'ass',
        }).on('data', (chunk: Buffer) => {
            rawAss += chunk.toString("utf8");
        });
    
        await ffmpeg.run();

        const parsedAss = parseAss(rawAss);
        const dialogue = parsedAss.events.dialogue.sort((a, b) => a.Start - b.Start);

        let cursor = dialogue[0]?.Start || 0;
        let currentConversationLines: Array<ParsedASSEvent> = [];

        for(let i = 0; i < dialogue.length; i++) {
            const currentLine = dialogue[i];
            cursor = Math.max(cursor, currentLine.End);
            currentConversationLines.push(currentLine);

            if(!dialogue[i+1] || dialogue[i+1].Start > cursor + conversationMaxPauseTime) {
                const conversationText = currentConversationLines.map(l => l.Text.combined).join("\n");
                const conversationId = db.insert('conversations', demand<Conversation>({
                    trackId: trackId,
                    indexedText: conversationText
                        .replace(/\\[Nnh]/g, " "),
                }));

                for(const line of currentConversationLines) {
                    db.insert('lines', demand<Line>({
                        conversationId,
                        rawText: line.Text.raw,
                        displayText: line.Text.combined,
                        startMs: Math.round(line.Start * 1000),
                        endMs: Math.round(line.End * 1000),
                    }));
                }

                currentConversationLines = [];
            }
        }

    } catch (err) {
        console.warn(err);
    }
}