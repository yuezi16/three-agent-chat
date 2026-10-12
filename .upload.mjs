// 一次性上传脚本：把本地这棵树同步到 GitHub（走 git data API，比 git push 稳）。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const REPO = 'yuezi16/three-agent-chat'
const BRANCH = 'main'
const TOKEN = readFileSync('C:/Users/tsuki/Documents/hasumi021/.secret/github-token-new.txt', 'utf8').trim()
const root = process.cwd()

const api = async (path, init = {}) => {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + TOKEN,
      accept: 'application/vnd.github+json',
      'user-agent': 'hasumi-agent',
      'content-type': 'application/json',
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean)
console.log('要传的文件：', files.length)
const entries = []
for (const rel of files) {
  const buf = readFileSync(join(root, rel))
  const blob = await api(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }) })
  entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
}
const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`)
const baseCommit = await api(`/repos/${REPO}/git/commits/${ref.object.sha}`)
const tree = await api(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }) })
const message = execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' }).trim()
const commit = await api(`/repos/${REPO}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) })
await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) })
console.log('OK', commit.sha)
