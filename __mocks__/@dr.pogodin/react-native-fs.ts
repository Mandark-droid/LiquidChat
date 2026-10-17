/** Test double for react-native-fs over a temp directory on the host FS. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rnfs-'));
export const DocumentDirectoryPath = path.join(root, 'docs');
export const CachesDirectoryPath = path.join(root, 'cache');
fs.mkdirSync(DocumentDirectoryPath, { recursive: true });
fs.mkdirSync(CachesDirectoryPath, { recursive: true });

export const exists = async (p: string) => fs.existsSync(p);
export const mkdir = async (p: string) => {
  fs.mkdirSync(p, { recursive: true });
};
export const writeFile = async (p: string, data: string, enc = 'utf8') => {
  fs.writeFileSync(p, data, enc === 'base64' ? 'base64' : 'utf8');
};
export const appendFile = async (p: string, data: string, enc = 'utf8') => {
  fs.appendFileSync(p, data, enc === 'base64' ? 'base64' : 'utf8');
};
export const read = async (p: string, length: number, position: number, enc = 'utf8') => {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, position);
    return buf.subarray(0, n).toString(enc === 'base64' ? 'base64' : 'utf8');
  } finally {
    fs.closeSync(fd);
  }
};
export const stat = async (p: string) => {
  const st = fs.statSync(p);
  return { size: st.size, isFile: () => st.isFile(), isDirectory: () => st.isDirectory() };
};
export const readFile = async (p: string, enc = 'utf8') =>
  fs.readFileSync(p, enc === 'base64' ? 'base64' : 'utf8');
export const unlink = async (p: string) => {
  fs.rmSync(p, { recursive: true, force: true });
};
export const moveFile = async (a: string, b: string) => {
  fs.renameSync(a, b);
};
export const readDir = async (p: string) =>
  fs.readdirSync(p).map(name => {
    const full = path.join(p, name);
    const st = fs.statSync(full);
    return {
      name,
      path: full,
      size: st.size,
      isDirectory: () => st.isDirectory(),
      isFile: () => st.isFile(),
    };
  });
