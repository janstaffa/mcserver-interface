import { ChildProcessWithoutNullStreams, exec, spawn } from 'child_process';
import { BACKUP_PATH } from './constants';

export const shutdown = () => exec('shutdown now');
export const makeBackupName = (id: string) => 'mechanicalcraft' + id;

export const createBackup = (
  filename?: string
): [string, ChildProcessWithoutNullStreams] => {
  if (filename === undefined) {
    filename = makeBackupName(Date.now().toString());
  }

  const fullName = `${filename}.tar.gz`;
  return [
    fullName,
    spawn('tar', ['-zcf', BACKUP_PATH + fullName, 'mechanicalcraft']),
  ];
};

export interface Server {
  status: ServerStatus;
  getStatus: () => string;
  process?: ChildProcessWithoutNullStreams;
  start: () => void;
  stop: () => boolean;
}

export enum ServerStatus {
  Online,
  Offline,
  Starting,
  Stopping,
}

const MCServerParams = [
  '-Xmx7G',
  '-XX:ParallelGCThreads=2',
  '-XX:+UseConcMarkSweepGC',
  '-XX:+UseParNewGC',
  '-jar',
  'forge-server.jar',
  '-Dfml.readTimeout=180',
  '-Dfml.queryResult=confirm',
  '-Dlog4j.configurationFile=log4j2_112-116.xml',
  'nogui',
];
export const startMCServerProcess = () => {
  return spawn('java', MCServerParams);
};

export const spawnSyncProcess = (command: string, args: string[]) => {
  return new Promise((res, rej) => {
    const process = spawn(command, args);
    process
      .on('close', res)
      .on('disconnect', res)
      .on('exit', res)
      .on('error', rej);
  });
};

const formatLog = (msg: string) => `[${new Date().toISOString()}] - ${msg}`;
export const log = (msg: string) => console.log(formatLog(msg));
export const error = (msg: string) => console.error(formatLog(msg));
