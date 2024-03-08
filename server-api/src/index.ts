import { exec } from 'child_process';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import { RCON } from 'minecraft-server-util';
import path from 'path';
import { createClient } from 'redis';
import sqlite3 from 'sqlite3';
import WebSocket from 'ws';
import {
  BACKUP_PATH,
  DATA_PATH,
  MC_SERVER_NAME,
  REDIS_PUBLIC_CHANNEL,
  REDIS_URL,
  SERVER_ADDRESS
} from './constants';
import { WSMessage } from './types';
import {
  Server,
  ServerStatus,
  createBackup,
  error,
  log,
  makeBackupName,
  shutdown,
  spawnSyncProcess,
  startMCServerProcess
} from './util';
import { initializeWebsocket } from './websocket';

const createRedisClient = async () => {
  const c = createClient({
    url: REDIS_URL,
  });
  await c.connect();

  return c;
};

(async () => {
  dotenv.config();

  // sqlite setup
  const SQLite = sqlite3.verbose();
  const db = new SQLite.Database('/home/mcserver/ftp/server/server_api/backups.db');

  // redis setup

  const pub = await createRedisClient();
  const sub = await createRedisClient();

  const query = (command: string, method: string = 'all') => {
    return new Promise((resolve, reject) => {
      // @ts-ignore
      db[method](command, (error: any, result: any) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  };

  db.serialize(async () => {
    await query(
      'CREATE TABLE IF NOT EXISTS backups (id INTEGER UNIQUE, name TEXT, date TEXT)',
      'run'
    );
  });

  const serverDir = path.join('/home/mcserver/ftp/server');
  process.chdir(serverDir);

  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));


  // serve backups without authentication middleware
  app.get('/api/backup/:id', (req, res) => {
    const id = req.params['id'];
    const file = makeBackupName(id) + '.tar.gz';
    res.download(BACKUP_PATH + file);
  });

  // initialize the server object
  let server: Server = {
    status: ServerStatus.Offline,
    getStatus: () => {
      switch (server.status) {
        case ServerStatus.Online:
          return 'ONLINE';
        case ServerStatus.Offline:
          return 'OFFLINE';
        case ServerStatus.Starting:
          return 'STARTING';
        case ServerStatus.Stopping:
          return 'STOPPING';
      }
    },
    start: () => {
      log('Starting the server.');
      server.process = startMCServerProcess();
      server.process.stdout.setEncoding('utf8');

      // default 'close' event listener
      server.process.addListener('close', (code) => {
        server.status = ServerStatus.Offline;
      });

      server.status = ServerStatus.Starting;

      server.process.stdout.addListener('data', (chunk) => {
        const message: WSMessage<string> = { code: 1001, payload: chunk };
        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
      });

      const interval = setInterval(async () => {
        try {
          if (server.status === ServerStatus.Starting) {
            const client = new RCON();
            await client.connect(SERVER_ADDRESS, 25575);

            await client.close();

              server.status = ServerStatus.Online;
              
              setTimeout(() => {
                  exec('bash /home/mcserver/ftp/server/server_api/move_markers.sh');
              }, 90000);

            const message: WSMessage<string> = { code: 1002, payload: server.getStatus() };
            pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
          }
          clearInterval(interval);
        } catch (e) {
          error(e);
        }
      }, 5000);
    },
    stop: () => {
      if (!server.process) return false;
      server.process.stdout.removeAllListeners('data');
      const result = server.process.kill();
      if (result) {
        server.status = ServerStatus.Stopping;
      }
      return result;
    },
  };

  var authentication = (req: any, res: any, next: any) => {
    const key = req.header('key');
    if (!key || key !== process.env.SECRET_KEY)
      return res.send('Not authenticated.');

    next();
  };

  // apply authentication middleware
  app.use(authentication);

  // get the current server status
  app.get('/api/status', (_, res) => {
    const statusString = server.getStatus();
    res.send(statusString);
  });

  // start the server
  app.post('/api/start', (_, res) => {
    if (server.status !== ServerStatus.Offline) {
      res.send(`Err: the server is not ready. Status: ${server.getStatus()}.`);
      return;
    }

    const message: WSMessage<string> = { code: 1003, payload: "Starting minecraft server." };

    pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

    try {
      server.start();
    } catch (e) {
      res.send(e);
      return;
    }

    res.send('OK');
  });

  // auto backup the minecraft world
  const autoBackupMCWorld = async (): Promise<void> => {
    return new Promise((res, rej) => {
      const [backupName, backup_process] = createBackup(
        'latest_automatic_backup'
      );
      backup_process.on('close', async () => {
        await query(
          `
          INSERT OR REPLACE INTO backups (id, name, date) values
          (0, "${backupName}", "${new Date().toISOString()}")
         `, 'run'
        ).catch((e) => {
          rej(e);
        });

        res();
      });
    });
  };
  // stop the minecraft server
  const stopMCServer = async (): Promise<void> => {
    return new Promise((res, rej) => {
      if (server.status === ServerStatus.Offline || !server.process) {
        return rej('The server is offline.');
      }

      // run this only once
      const handler = () => {
        server.process?.removeListener('close', handler);
        res();
      };
      // remove defaul event listener
      server.process.removeAllListeners('close');
      server.process.addListener('close', handler);

      const result = server.stop();

      if (!result) {
        rej('Unknown error.');
      }
    });
  };

  const gracefullyStopMCServer = (): Promise<void> => {
    log('Gracefully stopping the server.');
    return new Promise((res, rej) => {
      if (server.status === ServerStatus.Offline)
        return rej('The server is offline');
      if (server.status === ServerStatus.Stopping)
        return rej('The server is already stopping.');

      const prevStatus = server.status;
      server.status = ServerStatus.Stopping;

      const message: WSMessage<string> = {
        code: 1003,
        payload: 'Gracefully stopping the server.',
      };
      pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

      stopMCServer()
        .then(() => {
          const message: WSMessage<string> = {
            code: 1003,
            payload: 'Backing up the world.',
          };
          pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

          log('Backing up the world.');
          return autoBackupMCWorld().then(() => {
            server.status = ServerStatus.Offline;
            log('Server was stopped.');
            res();
          });
        })
        .catch((e) => {
          error('Failed to gracefully stop the server. ' + e);
          server.status = prevStatus;
          rej(e);
        });
    });
  };
  // stop the server but keep the machine running
  app.post('/api/stop', (req, res) => {
    gracefullyStopMCServer()
      .then(() => {
        const message: WSMessage<string> = {
          code: 1003,
          payload: 'The Server was stopped.',
        };
        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
      })
      .catch((e) => {
        const message: WSMessage<string> = {
          code: 1004,
          payload: 'Failed to stop the server. ' + e,
        };

        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
      });
    res.send('OK');
  });

  app.post('/api/shutdown', (req, res) => {
    if (server.status === ServerStatus.Stopping) {
      res.send('Err: the server is stopping.');
      return;
    }

    gracefullyStopMCServer()
      .then(() => {
        const message: WSMessage<string> = {
          code: 1003,
          payload: 'The Server was stopped.',
        };
        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
      }).catch((_e) => { }).finally(() => {
        const message: WSMessage<string> = {
          code: 1003,
          payload: 'Shutting down the computer.',
        };
        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

        shutdown()
      });

    res.send('OK');
  });
  // send a command using RCON
  app.post('/api/command', async (req, res) => {
    if(!(server.status === ServerStatus.Online || server.status === ServerStatus.Starting)) {
      res.send({ error: 1, message: "Cannot execute the command, the server is not running."});
      return;
    }
    const command = req.body['command'];

    if (!command) {
      res.send({ error: 1, message: 'No command provided.' });
      return;
    }

    const client = new RCON();

    try {
      await client.connect(SERVER_ADDRESS, 25575);
      await client.login(process.env.RCON_PASSWORD!);

      const result = await client.execute(command);

      await client.close();

      res.send({ error: 0, result });
    } catch (e) {
      error(e);
      res.send({ error: 1, message: `Failed to execute command: '${command}'.` });
    }
  });

  // create a backup of the current world
  app.post('/api/backup', async (req, res) => {
    if (server.status !== ServerStatus.Offline) {
      res.send('Err: cannot backup when the server is running.');
      return;
    }

    log('Backing up the world.');
    const message: WSMessage<string> = {
      code: 1003,
      payload: 'Backing up the world.',
    };

    pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

    const time = Date.now();
    const id = time.toString();
    const fileName = makeBackupName(id);

    const [backupName, backup_process] = createBackup(fileName);
    backup_process.on('close', () => {
      query(
        `INSERT INTO backups VALUES (${time}, "${backupName}", "${new Date().toISOString()}")`,
        'run'
      )
        .then(() => {
          log(`Backup '${id}' was created.`);
          const message: WSMessage<string> = {
            code: 1003,
            payload: `Backup '${id}' was created.`,
          };

          pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
        })
        .catch((e) => {
          error(e);
          const message: WSMessage<string> = {
            code: 1004,
            payload: 'Failed to create a backup. Database error.',
          };

          pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
        });
    });

    res.send('OK');
  });

  // get all available backups
  app.get('/api/backups', async (req, res) => {
    try {
      const result = await query('SELECT * FROM backups').catch((e) => {
        throw e;
      });
      res.json({ error: 0, result });
    } catch (e) {
      res.json({ error: 1, message: 'Failed to query database.' });
    }
  });

  // load a backup
  app.post('/api/backup/load/:id', async (req, res) => {
    if (server.status !== ServerStatus.Offline) {
      res.send(
        'Err: cannot load a backup when the server is running. In order to succeed, stop it first.'
      );
      return;
    }

    const id = req.params['id'];

    const message: WSMessage<string> = {
      code: 1003,
      payload: `Loading backup '${id}'.`,
    };
    pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

    const backupName = makeBackupName(id);
    const filePath = backupName + '.tar.gz';
    const fullPath = BACKUP_PATH + filePath;

    try {
      const exists = (await query(
        `SELECT 1 FROM backups WHERE id=${id} LIMIT 1`,
        'all'
      ).catch((e) => {
        throw e;
      })) as [];

      if (!fs.existsSync(fullPath) || exists.length === 0) throw new Error();
    } catch (e) {
      error(e);
      res.send(`Err: backup '${id}' was not found.`);
    }

    new Promise(async (_, rej) => {
      try {
        // remove all contents of the data directory
        await spawnSyncProcess('rm', ['-r', DATA_PATH + '*']).catch((e) => {
          throw e;
        });
        // untar the backup archive into the data directory
        await spawnSyncProcess('tar', [
          '-zxf',
          fullPath,
          MC_SERVER_NAME,
        ]).catch((e) => {
          throw e;
        });
      } catch (e) {
        return rej(e);
      }

      const message: WSMessage<string> = {
        code: 1003,
        payload: `The backup '${id}' was loaded.`,
      };

      pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
    }).catch((e) => {
      error(e);
      const message: WSMessage<string> = {
        code: 1004,
        payload: 'Failed to load the backup. Unknown error.',
      };

      pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
    });
    res.send('OK');
  });

  // restart the MC server
  app.post('/api/restart', async (req, res) => {
    if (server.status !== ServerStatus.Online || !server.process) {
      res.send(
        "Err: couldn't restart the server. Make sure the server is running."
      );
      return;
    }

    const message: WSMessage<string> = {
      code: 1003,
      payload: 'Restarting the server.',
    };
    pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));

    gracefullyStopMCServer()
      .then(() => {
        const message: WSMessage<string> = {
          code: 1003,
          payload: 'The Server was stopped, restarting.',
        };
        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
        server.start();
      })
      .catch((e) => {
        const message: WSMessage<string> = {
          code: 1004,
          payload: 'Failed to stop the server. ' + e,
        };
        pub.publish(REDIS_PUBLIC_CHANNEL, JSON.stringify(message));
      });
    res.send('OK');
  });

  const PORT = 25566;
  const s = app.listen(PORT, () => {
    log(`Server listening at http://localhost:${PORT}`);
  });

  // initialize ws server
  let wss = initializeWebsocket(s);

  let is_connected = false;
  let _ws: WebSocket | null = null

  wss.on('connection', async (ws, _req) => {
    if (is_connected) {
      _ws?.terminate();
    }
    _ws = ws;

    is_connected = true;

    ws.on('close', () => {
      is_connected = false;
    });
    await sub.subscribe(REDIS_PUBLIC_CHANNEL, (message) => {
      _ws?.send(message);
    });
  });
})();
