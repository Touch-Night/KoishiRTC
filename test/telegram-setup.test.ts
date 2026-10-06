import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const loginPath = fileURLToPath(new URL('../bridge/telegram/login.py', import.meta.url));
const setupPath = fileURLToPath(new URL('../bridge/telegram/setup.py', import.meta.url));

function python(source: string) {
  const result = spawnSync('python3', ['-c', source, loginPath, setupPath], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

const load = `
import asyncio, contextlib, importlib.util, io, json, os, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location('telegram_login', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def config(directory):
    return dict(apiId=12345, apiHash='a' * 32, selfId='123456789', sessionPath=str(pathlib.Path(directory) / 'account.session'))
class PasswordNeeded(Exception): pass
telethon = types.ModuleType('telethon')
telethon.TelegramClient = None
errors = types.ModuleType('telethon.errors')
errors.SessionPasswordNeededError = PasswordNeeded
sys.modules['telethon'] = telethon
sys.modules['telethon.errors'] = errors
class Client:
    authorized = True
    account_id = 123456789
    bot = False
    needs_password = False
    calls = None
    def __init__(self, session, api_id, api_hash):
        self.calls = []
        self.session = types.SimpleNamespace(save_entities=True)
        pathlib.Path(session).touch()
        self.path = session
    async def connect(self): self.calls.append('connect')
    async def is_user_authorized(self): return self.authorized
    async def send_code_request(self, phone):
        self.calls.append(('send_code', phone))
        return types.SimpleNamespace(phone_code_hash='private-code-hash')
    async def sign_in(self, **args):
        self.calls.append(('sign_in', args))
        if self.needs_password and 'password' not in args: raise PasswordNeeded()
    async def get_me(self): return types.SimpleNamespace(id=self.account_id, bot=self.bot)
    async def disconnect(self): self.calls.append('disconnect')
`;

test('Telegram login validates local JSON and requires an explicit absolute persistent session', () => {
  python(load + `
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'config.json'
    valid = config(directory)
    path.write_text(json.dumps(valid))
    assert module.load_config(path) == valid
    for key, value in [('apiId', True), ('apiId', 0), ('apiHash', 'secret-invalid-hash'), ('selfId', True), ('selfId', '@user'), ('sessionPath', 'account.session'), ('sessionPath', '/tmp/session')]:
        path.write_text(json.dumps(dict(valid, **{key: value})))
        try: module.load_config(path)
        except module.LoginError as error:
            assert 'secret-invalid-hash' not in str(error)
        else: raise AssertionError(key)
    path.write_text('{"apiHash":"private-secret"')
    try: module.load_config(path)
    except module.LoginError as error: assert 'private-secret' not in str(error)
    else: raise AssertionError('invalid JSON accepted')
`);
});

test('authorized Telegram session checks ordinary-user identity without login prompts or calls', () => {
  python(load + `
with tempfile.TemporaryDirectory() as directory:
    settings = config(directory)
    client = Client(settings['sessionPath'], settings['apiId'], settings['apiHash'])
    def no_prompt(_): raise AssertionError('already authorized')
    asyncio.run(module.login(settings, client_factory=lambda *args: client, prompt=no_prompt))
    assert client.calls == ['connect', 'disconnect']
    assert client.session.save_entities is False
    if os.name == 'posix': assert pathlib.Path(client.path).stat().st_mode & 0o777 == 0o600
`);
});

test('Telegram code and two-step verification stay local and passwords retain whitespace', () => {
  const result = python(load + `
with tempfile.TemporaryDirectory() as directory:
    settings = config(directory)
    client = Client(settings['sessionPath'], settings['apiId'], settings['apiHash'])
    client.authorized = False
    client.needs_password = True
    inputs = iter(['+12345678901', '12345', '  private-password  '])
    asyncio.run(module.login(settings, client_factory=lambda *args: client, prompt=lambda _: next(inputs)))
    assert client.calls == ['connect', ('send_code', '+12345678901'), ('sign_in', dict(phone='+12345678901', code='12345', phone_code_hash='private-code-hash')), ('sign_in', dict(password='  private-password  ')), 'disconnect']
`);
  assert.equal(result.stdout + result.stderr, '');
});

test('Telegram refuses bots and mismatched user sessions and always disconnects', () => {
  python(load + `
for bot, identity in [(True, 123456789), (False, 987654321)]:
    with tempfile.TemporaryDirectory() as directory:
        settings = config(directory)
        client = Client(settings['sessionPath'], settings['apiId'], settings['apiHash'])
        client.bot, client.account_id = bot, identity
        try: asyncio.run(module.login(settings, client_factory=lambda *args: client))
        except module.LoginError: pass
        else: raise AssertionError('wrong account accepted')
        assert client.calls == ['connect', 'disconnect']
`);
});

test('Telegram login rejects unsafe session directories and noninteractive secret input', () => {
  python(load + `
try: module.hidden_input('secret: ')
except module.LoginError: pass
else: raise AssertionError('noninteractive input accepted')
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'public'
    path.mkdir(mode=0o755)
    if os.name == 'posix':
        path.chmod(0o755)
        try: module.prepare_session(str(path / 'account.session'))
        except module.LoginError: pass
        else: raise AssertionError('unsafe session directory accepted')
    symlink = pathlib.Path(directory) / 'linked.session'
    symlink.symlink_to(pathlib.Path(directory) / 'real.session')
    try: module.prepare_session(str(symlink))
    except module.LoginError: pass
    else: raise AssertionError('session symlink accepted')
`);
});

test('Telegram login CLI suppresses raw exceptions and restores its umask after failure', () => {
  const result = python(load + `
with tempfile.TemporaryDirectory() as directory:
    settings = config(directory)
    path = pathlib.Path(directory) / 'config.json'
    path.write_text(json.dumps(settings))
    class Failing(Client):
        async def send_code_request(self, phone): raise RuntimeError('private-phone-code-hash-password')
    client = Failing(settings['sessionPath'], settings['apiId'], settings['apiHash'])
    client.authorized = False
    original_login = module.login
    async def fail(config):
        return await original_login(config, client_factory=lambda *args: client, prompt=lambda _: '+12345678901')
    module.login = fail
    previous = os.umask(0o027)
    try:
        output = io.StringIO()
        with contextlib.redirect_stderr(output): assert module.main(['--config', str(path)]) == 1
        assert 'private-phone-code-hash-password' not in output.getvalue()
        assert 'Traceback' not in output.getvalue()
        assert os.umask(0o027) == 0o027
        assert client.calls[-1] == 'disconnect'
    finally: os.umask(previous)
`);
  assert.equal(result.stdout + result.stderr, '');
});

test('Telegram installer pins supported native dependencies and reports a missing venv without login', () => {
  const requirements = readFileSync(new URL('../bridge/telegram/requirements.txt', import.meta.url), 'utf8');
  for (const pin of ['py-tgcalls==3.0.0', 'ntgcalls==3.0.1', 'Telethon==1.45.0', 'Pillow==12.3.0']) {
    assert.ok(requirements.split('\n').includes(pin));
  }
  python(`
import contextlib, importlib.util, io, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('telegram_setup', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    output = io.StringIO()
    with contextlib.redirect_stderr(output):
        assert module.main(['doctor', '--venv', str(pathlib.Path(directory) / 'missing')]) == 1
    assert 'run install first' in output.getvalue()
    assert not (pathlib.Path(directory) / 'missing').exists()
`);
});

test('offline Telegram doctor only constructs and releases the native binding and checks JPEG', () => {
  python(`
import asyncio, importlib.util, sys, types
spec = importlib.util.spec_from_file_location('telegram_setup', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
events = []
class Native:
    def __init__(self): events.append('construct')
    def __del__(self): events.append('release')
class Picture:
    size = (2, 2)
    def save(self, output, format):
        assert format == 'JPEG'
        events.append('encode')
        output.write(b'fake-jpeg')
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def load(self): events.append('decode')
sys.modules['pytgcalls'] = types.ModuleType('pytgcalls')
sys.modules['telethon'] = types.ModuleType('telethon')
sys.modules['ntgcalls'] = types.SimpleNamespace(NTgCalls=Native)
sys.modules['PIL'] = types.SimpleNamespace(Image=types.SimpleNamespace(new=lambda *args: Picture(), open=lambda *args: Picture()))
module.importlib.metadata.version = lambda name: module.expected_versions()[name]
result = asyncio.run(module.native_smoke())
assert events == ['construct', 'encode', 'decode', 'release']
assert result['nativeSmoke'] and result['jpegCodec'] and result['accountConnected'] is False
events.clear()
module.importlib.metadata.version = lambda name: '0.0.0'
try: asyncio.run(module.native_smoke())
except RuntimeError: pass
else: raise AssertionError('wrong installed versions accepted')
assert events == []
`);
});

test('Telegram install runs pip only inside the specified virtual environment and requires native wheels', () => {
  python(`
import contextlib, importlib.util, io, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location('telegram_setup', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    target = pathlib.Path(directory) / 'isolated-env'
    executable = module.venv_python(target)
    class Builder:
        def __init__(self, **args): assert args == dict(with_pip=True)
        def create(self, path):
            assert path == target
            executable.parent.mkdir(parents=True)
            executable.touch()
            (target / 'pyvenv.cfg').touch()
    calls = []
    def run(args, **options):
        calls.append(args)
        assert args[:4] == [str(executable), '-m', 'pip', 'install']
        assert '--only-binary=ntgcalls,Pillow' in args
        assert str(module.REQUIREMENTS) == args[-1]
        assert options['capture_output'] is True
        return types.SimpleNamespace(returncode=0)
    module.venv.EnvBuilder = Builder
    module.subprocess.run = run
    module.run_doctor = lambda python: calls.append(['doctor', str(python)])
    with contextlib.redirect_stdout(io.StringIO()):
        assert module.main(['install', '--venv', str(target)]) == 0
    assert len(calls) == 2 and calls[-1] == ['doctor', str(executable)]
`);
});
