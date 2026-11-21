const fs = require('node:fs/promises')
const path = require('node:path')

const read = (name) => fs.readFile(path.join(__dirname, name), 'utf8')
const desks = ['operations', 'workforce', 'finance']

async function build() {
  const [template, snapshot, styles, scripts] = await Promise.all([
    read('shell.html'),
    read('snapshot.json').then(JSON.parse),
    Promise.all(['shell', ...desks].map((file) => read(`${file}.css`))),
    Promise.all([...desks, 'shell'].map((file) => read(`${file}.js`))),
  ])
  const payload = JSON.stringify(snapshot).replaceAll('<', '\\u003c')
  const files = scripts.map((script) => `<script>\n${script.replace(/<\/script/gi, '<\\/script')}\n</script>`)
  const init = `<script>window.sampleDashboards = {}; window.sampleSnapshot = ${payload};</script>`
  const html = template
    .replace('<!-- dashboard styles -->', () => `<style>\n${styles.join('\n')}\n</style>`)
    .replace('<!-- dashboard scripts -->', () => [init, ...files].join('\n'))
  await fs.writeFile(path.join(__dirname, 'index.html'), html)
}

build().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
