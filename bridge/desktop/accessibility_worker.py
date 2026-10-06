#!/usr/bin/env python3
"""Explicit process-bound accessibility; no mouse coordinates, global keys or capture."""
import importlib.util
import json
import os
import sys
import time
import uuid

MAX_NODES = 2500
MAX_DEPTH = 24


def text(value):
    return str(value or '')[:512]


def processes(application):
    import psutil
    executable = application.get('executable')
    if not isinstance(executable, str) or not os.path.isabs(executable):
        raise ValueError('Configure an absolute application executable path')
    expected = os.path.normcase(os.path.realpath(executable))
    result = []
    for proc in psutil.process_iter(['pid', 'exe', 'create_time', 'cmdline']):
        try:
            if application.get('pid') and proc.pid != application['pid']:
                continue
            if any(str(arg).startswith('--type=') for arg in (proc.info.get('cmdline') or [])):
                continue
            if proc.info['exe'] and os.path.normcase(os.path.realpath(proc.info['exe'])) == expected:
                result.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if len(result) != 1:
        raise ValueError('Expected exactly one process with the configured executable; pin pid if several instances exist')
    proc = result[0]
    if sys.platform == 'darwin' and application.get('bundleId'):
        from AppKit import NSRunningApplication
        app = NSRunningApplication.runningApplicationWithProcessIdentifier_(proc.pid)
        if app is None or app.bundleIdentifier() != application['bundleId']:
            raise ValueError('macOS application bundle identity does not match')
    return proc


class WindowsUI:
    def __init__(self, pid):
        from pywinauto import Desktop
        self.pid = pid
        self.desktop = Desktop(backend='uia')

    def roots(self):
        return self.desktop.windows(process=self.pid, visible_only=True)

    def children(self, node):
        return node.children()

    def read(self, node):
        info = node.element_info
        if info.process_id != self.pid:
            raise ValueError('Accessibility node belongs to another process')
        password = bool(getattr(info.element, 'CurrentIsPassword', False))
        value = ''
        if not password:
            try:
                value = node.iface_value.CurrentValue
            except Exception:
                pass
        actions = []
        try:
            node.iface_invoke
            actions.append('invoke')
        except Exception:
            pass
        try:
            if not password and not node.iface_value.CurrentIsReadOnly:
                actions.append('setValue')
        except Exception:
            pass
        return {'role': text(info.control_type), 'name': '' if password else text(info.name),
                'className': text(info.class_name), 'automationId': text(info.automation_id), 'value': text(value),
                'description': '', 'enabled': node.is_enabled(), 'visible': node.is_visible(),
                'protected': password, 'actions': actions}

    def act(self, node, operation, value):
        if operation == 'invoke':
            node.iface_invoke.Invoke()
        elif operation == 'setValue':
            node.iface_value.SetValue(value)
        else:
            raise ValueError('Unsupported accessibility action')


class MacUI:
    def __init__(self, pid):
        import ApplicationServices as ax
        self.ax, self.pid = ax, pid
        if not ax.AXIsProcessTrusted():
            raise PermissionError('Grant Accessibility permission to this Python interpreter/terminal in macOS Privacy settings')
        self.app = ax.AXUIElementCreateApplication(pid)
        ax.AXUIElementSetMessagingTimeout(self.app, 1.0)

    def attr(self, node, attribute, default=None):
        code, value = self.ax.AXUIElementCopyAttributeValue(node, attribute, None)
        return value if code == 0 else default

    def roots(self):
        return self.attr(self.app, 'AXWindows', [])

    def children(self, node):
        return self.attr(node, 'AXChildren', [])

    def read(self, node):
        code, pid = self.ax.AXUIElementGetPid(node, None)
        if code or pid != self.pid:
            raise ValueError('Accessibility node belongs to another process')
        role, subrole = self.attr(node, 'AXRole', ''), self.attr(node, 'AXSubrole', '')
        protected = subrole == 'AXSecureTextField'
        code, actions = self.ax.AXUIElementCopyActionNames(node, None)
        operations = ['invoke'] if code == 0 and 'AXPress' in (actions or []) else []
        code, settable = self.ax.AXUIElementIsAttributeSettable(node, 'AXValue', None)
        if code == 0 and settable and not protected:
            operations.append('setValue')
        value = self.attr(node, 'AXValue', '')
        if not isinstance(value, (str, int, float, bool)):
            value = ''
        return {'role': text(role), 'name': '' if protected else text(self.attr(node, 'AXTitle', '')),
                'className': text(subrole), 'automationId': text(self.attr(node, 'AXIdentifier', '')), 'value': '' if protected else text(value),
                'description': '' if protected else text(self.attr(node, 'AXDescription', '')),
                'enabled': bool(self.attr(node, 'AXEnabled', True)), 'visible': not bool(self.attr(node, 'AXHidden', False)),
                'protected': protected, 'actions': operations}

    def act(self, node, operation, value):
        if operation == 'invoke':
            code = self.ax.AXUIElementPerformAction(node, 'AXPress')
        elif operation == 'setValue':
            code = self.ax.AXUIElementSetAttributeValue(node, 'AXValue', value)
        else:
            raise ValueError('Unsupported accessibility action')
        if code != 0:
            raise RuntimeError('macOS Accessibility action rejected: ' + str(code))


class LinuxUI:
    def __init__(self, pid):
        import pyatspi
        self.api, self.pid = pyatspi, pid

    def roots(self):
        desktop = self.api.Registry.getDesktop(0)
        apps = [app for app in desktop if app.get_process_id() == self.pid]
        if not apps:
            raise RuntimeError('No AT-SPI tree for this process; enable accessibility support in this application/session')
        return apps

    def children(self, node):
        return [node.getChildAtIndex(i) for i in range(min(node.childCount, MAX_NODES))]

    def read(self, node):
        app = node.getApplication()
        if app and app.get_process_id() != self.pid:
            raise ValueError('Accessibility node belongs to another process')
        state = node.getState()
        protected = node.getRole() == self.api.ROLE_PASSWORD_TEXT
        actions = []
        try:
            action = node.queryAction()
            if any(action.getName(i).lower() in ('click', 'press', 'activate') for i in range(action.nActions)):
                actions.append('invoke')
        except Exception:
            pass
        value = ''
        if not protected:
            try:
                content = node.queryText()
                value = content.getText(0, min(content.characterCount, 512))
            except Exception:
                pass
            if state.contains(self.api.STATE_EDITABLE):
                actions.append('setValue')
        attributes = dict(item.split(':', 1) for item in node.getAttributes() if ':' in item)
        return {'role': text(node.getRoleName()), 'name': '' if protected else text(node.name),
                'className': text(attributes.get('class', '')), 'automationId': text(attributes.get('id', attributes.get('accessible-id', ''))),
                'value': text(value), 'description': '' if protected else text(node.description),
                'enabled': state.contains(self.api.STATE_ENABLED), 'visible': state.contains(self.api.STATE_SHOWING),
                'protected': protected, 'actions': actions}

    def act(self, node, operation, value):
        if operation == 'setValue':
            if not node.queryEditableText().setTextContents(value):
                raise RuntimeError('AT-SPI text update rejected')
        elif operation == 'invoke':
            action = node.queryAction()
            names = [(i, action.getName(i).lower()) for i in range(action.nActions)]
            selected = [i for i, name in names if name in ('click', 'press', 'activate')]
            if len(selected) != 1 or not action.doAction(selected[0]):
                raise RuntimeError('AT-SPI action missing, ambiguous or rejected')
        else:
            raise ValueError('Unsupported accessibility action')


def check_guards(snapshot, guards):
    """Re-evaluate exact semantic evidence in the fresh tree immediately before invoke."""
    if snapshot['truncated'] or not isinstance(guards, dict) or set(guards) != {'all', 'none'}:
        raise ValueError('Incomplete or invalid commit evidence')
    nodes = snapshot['nodes']
    by_id = {node['id']: node for node in nodes}
    fields = {'role', 'name', 'value', 'automationId', 'description', 'className'}

    def valid(selector, depth=0):
        if not isinstance(selector, dict) or depth > 3 or not (set(selector) & fields) or set(selector) - fields - {'ancestor'}:
            raise ValueError('Invalid evidence selector')
        if any(not isinstance(value, str) or len(value) > 512 for key, value in selector.items() if key != 'ancestor'):
            raise ValueError('Invalid evidence text')
        if 'ancestor' in selector:
            valid(selector['ancestor'], depth + 1)

    def matches(node, selector):
        if not node.get('visible') or node.get('protected') or any(node.get(key) != value for key, value in selector.items() if key != 'ancestor'):
            return False
        if 'ancestor' not in selector:
            return True
        parent, seen = by_id.get(node.get('parentId')), set()
        while parent and parent['id'] not in seen:
            seen.add(parent['id'])
            if matches(parent, selector['ancestor']):
                return True
            parent = by_id.get(parent.get('parentId'))
        return False

    for key, expected in [('all', 1), ('none', 0)]:
        selectors = guards[key]
        if not isinstance(selectors, list) or len(selectors) > 32 or (key == 'all' and not selectors):
            raise ValueError('Invalid evidence condition')
        for selector in selectors:
            valid(selector)
            if sum(matches(node, selector) for node in nodes) != expected:
                raise ValueError('Account, target, audio route or call state changed before control submission')


class Worker:
    def __init__(self, application):
        self.application = application
        self.epoch = None
        self.nodes = {}
        self.process = None
        self.driver = None
        self.snapshot_at = 0

    def snapshot(self):
        self.epoch, self.nodes = str(uuid.uuid4()), {}
        proc = processes(self.application)
        identity = str(proc.pid) + ':' + str(proc.create_time())
        if not self.process or self.process != identity:
            self.driver = {'win32': WindowsUI, 'darwin': MacUI, 'linux': LinuxUI}[sys.platform](proc.pid)
            self.process = identity
        output, truncated = [], False
        queue = [(root, None, 0) for root in self.driver.roots()]
        seen = set()
        while queue and len(output) < MAX_NODES:
            node, parent, depth = queue.pop(0)
            if node is None or depth > MAX_DEPTH:
                truncated = True
                continue
            try:
                data = self.driver.read(node)
                key = str(len(output))
                output.append({'id': key, 'parentId': parent, **data})
                self.nodes[key] = (node, data)
                if not data['protected']:
                    queue.extend((child, key, depth + 1) for child in self.driver.children(node))
            except Exception:
                # Incomplete snapshots cannot prove absence or stable idle.
                truncated = True
        self.snapshot_at = time.monotonic()
        return {'epoch': self.epoch, 'processIdentity': identity, 'processId': proc.pid,
                'executable': os.path.realpath(proc.exe()), 'platform': sys.platform,
                'observedAt': int(time.time() * 1000), 'truncated': truncated or bool(queue), 'nodes': output}

    def act(self, request):
        if request.get('epoch') != self.epoch or time.monotonic() - self.snapshot_at > 5:
            raise ValueError('Accessibility snapshot is stale')
        proc = processes(self.application)
        if str(proc.pid) + ':' + str(proc.create_time()) != self.process:
            raise ValueError('Application process changed')
        node, prior = self.nodes.get(request.get('nodeId'), (None, None))
        if node is None or self.driver.read(node) != prior:
            raise ValueError('Selected accessibility node changed; inspect again')
        if request.get('guards') is not None:
            generation = self.process
            fresh = self.snapshot()
            if fresh['processIdentity'] != generation:
                raise ValueError('Application restarted during commit verification')
            check_guards(fresh, request['guards'])
            if self.driver.read(node) != prior:
                raise ValueError('Selected call control changed while verifying evidence')
        operation = request.get('operation')
        if not prior['visible'] or not prior['enabled'] or prior['protected'] or operation not in prior['actions']:
            raise ValueError('Selected accessibility operation is unavailable')
        value = request.get('value', '')
        if not isinstance(value, str) or len(value) > 512:
            raise ValueError('Invalid input value')
        self.driver.act(node, operation, value)
        self.epoch = None
        return {'submitted': True, 'evidence': 'accessibility-action-returned', 'remoteConfirmed': False}


def diagnostics():
    modules = {'win32': ['psutil', 'pywinauto'], 'darwin': ['psutil', 'ApplicationServices', 'AppKit'], 'linux': ['psutil', 'pyatspi']}.get(sys.platform, [])
    present = {name: importlib.util.find_spec(name) is not None for name in modules}
    return {'platform': sys.platform, 'available': bool(present) and all(present.values()), 'modules': present, 'opensAudio': False, 'performsActions': False}


def main():
    if sys.argv[1:] == ['--diagnostics']:
        print(json.dumps(diagnostics()))
        return
    if len(sys.argv) != 3 or sys.argv[1] != '--application':
        raise ValueError('Use --diagnostics or --application with explicit JSON identity')
    worker = Worker(json.loads(sys.argv[2]))
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line:
            break
        if len(line) > 65536 or not line.endswith(b'\n'):
            raise ValueError('Accessibility request exceeds size limit')
        request = {}
        try:
            request = json.loads(line)
            if request.get('operation') == 'snapshot':
                result = worker.snapshot()
            elif request.get('operation') in ('invoke', 'setValue'):
                result = worker.act(request)
            else:
                raise ValueError('Unknown accessibility request')
            output = {'id': request.get('id'), 'ok': True, 'result': result}
        except Exception as error:
            output = {'id': request.get('id'), 'ok': False, 'error': {'code': type(error).__name__, 'message': str(error)[:512]}}
        sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write(type(error).__name__ + ': ' + str(error)[:512] + '\n')
        sys.exit(1)
