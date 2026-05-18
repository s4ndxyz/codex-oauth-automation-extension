const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadDesktopAuthorizeRunnerApi() {
  const stateSource = fs.readFileSync('background/kiro/state.js', 'utf8');
  const clientSource = fs.readFileSync('background/kiro/desktop-client.js', 'utf8');
  const runnerSource = fs.readFileSync('background/kiro/desktop-authorize-runner.js', 'utf8');
  const globalScope = {};
  new Function('self', `${stateSource}; ${clientSource}; ${runnerSource}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundKiroDesktopAuthorizeRunner;
}

function createDesktopAuthorizeState(overrides = {}) {
  return {
    kiroRuntime: {
      session: {
        desktopTabId: 91,
      },
      register: {
        email: 'kiro-user@example.com',
      },
      desktopAuth: {
        region: 'us-east-1',
        clientId: 'desktop-client-id',
        clientSecret: 'desktop-client-secret',
        state: 'desktop-state-001',
        codeVerifier: 'desktop-code-verifier',
        redirectUri: 'http://127.0.0.1:43121/oauth/callback',
        redirectPort: 43121,
        authorizeUrl: 'https://example.com/authorize',
      },
      upload: {},
    },
    ...overrides,
  };
}

test('kiro desktop authorize runner exposes a factory and callback parser', () => {
  const api = loadDesktopAuthorizeRunnerApi();
  assert.equal(typeof api?.createKiroDesktopAuthorizeRunner, 'function');
  assert.equal(typeof api?.parseDesktopCallbackUrl, 'function');
});

test('parseDesktopCallbackUrl validates state and redirect port', () => {
  const api = loadDesktopAuthorizeRunnerApi();

  const success = api.parseDesktopCallbackUrl(
    'http://127.0.0.1:43121/oauth/callback?code=auth-code-001&state=state-001',
    'state-001',
    43121
  );
  assert.deepEqual(success, {
    url: 'http://127.0.0.1:43121/oauth/callback?code=auth-code-001&state=state-001',
    code: 'auth-code-001',
    state: 'state-001',
  });

  const badState = api.parseDesktopCallbackUrl(
    'http://127.0.0.1:43121/oauth/callback?code=auth-code-001&state=wrong-state',
    'state-001',
    43121
  );
  assert.equal(Object.prototype.hasOwnProperty.call(badState, 'code'), false);
  assert.match(badState.error, /state/i);

  const badPort = api.parseDesktopCallbackUrl(
    'http://127.0.0.1:43122/oauth/callback?code=auth-code-001&state=state-001',
    'state-001',
    43121
  );
  assert.equal(badPort, null);
});

test('kiro desktop authorize runner uses a shared 3-minute page-load timeout budget', () => {
  const source = fs.readFileSync('background/kiro/desktop-authorize-runner.js', 'utf8');
  assert.match(source, /DEFAULT_KIRO_PAGE_LOAD_TIMEOUT_MS/);
  assert.match(source, /createTimeoutBudget/);
  assert.match(source, /resolveTimeoutBudget/);
  assert.match(source, /timeoutBudget\.getRemainingMs\(1000\)/);
  assert.match(source, /onRetryableError: buildDesktopRetryRecovery\(tabId, \{\s*\.\.\.options,\s*timeoutBudget,/);
  assert.match(source, /awaitingCallbackAfterConsent/);
  assert.match(source, /finalizeDesktopAuthorizeCallback/);
});

test('executeKiroCompleteDesktopAuthorize finishes from callback page without waiting for tracker replay', async () => {
  const api = loadDesktopAuthorizeRunnerApi();
  let currentState = createDesktopAuthorizeState();
  let completedPayload = null;

  const runner = api.createKiroDesktopAuthorizeRunner({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async (tabId) => ({
          id: tabId,
          status: 'complete',
          url: 'http://127.0.0.1:43121/oauth/callback?code=auth-code-001&state=desktop-state-001',
        }),
        remove: async () => {},
        update: async () => ({}),
      },
      webNavigation: {
        onBeforeNavigate: { addListener: () => {} },
        onCommitted: { addListener: () => {} },
      },
      webRequest: {
        onBeforeRequest: { addListener: () => {} },
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        accessToken: 'access-token-001',
        refreshToken: 'refresh-token-001',
      }),
    }),
    getState: async () => currentState,
    getTabId: async () => 91,
    isTabAlive: async () => true,
    registerTab: async () => {},
    sendToContentScriptResilient: async (_source, message) => {
      if (message.type === 'GET_KIRO_DESKTOP_AUTHORIZE_STATE') {
        return {
          state: 'callback_page',
          url: 'http://127.0.0.1:43121/oauth/callback?code=auth-code-001&state=desktop-state-001',
        };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    },
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async () => ({ status: 'complete' }),
  });

  await runner.executeKiroCompleteDesktopAuthorize(currentState);

  assert.equal(completedPayload?.kiroRuntime?.desktopAuth?.authorizationCode, 'auth-code-001');
  assert.equal(completedPayload?.kiroRuntime?.desktopAuth?.refreshToken, 'refresh-token-001');
});

test('executeKiroCompleteDesktopAuthorize waits for callback after consent even if original tab disappears', async () => {
  const api = loadDesktopAuthorizeRunnerApi();
  let currentState = createDesktopAuthorizeState({
    kiroRuntime: {
      session: {
        desktopTabId: 91,
      },
      register: {
        email: 'kiro-user@example.com',
      },
      desktopAuth: {
        region: 'us-east-1',
        clientId: 'desktop-client-id',
        clientSecret: 'desktop-client-secret',
        state: 'desktop-state-002',
        codeVerifier: 'desktop-code-verifier',
        redirectUri: 'http://127.0.0.1:43121/oauth/callback',
        redirectPort: 43121,
        authorizeUrl: 'https://example.com/authorize',
      },
      upload: {},
    },
  });
  let completedPayload = null;
  let tabAlive = true;
  let navigationListener = null;

  const runner = api.createKiroDesktopAuthorizeRunner({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async (tabId) => {
          if (!tabAlive) {
            throw new Error(`No tab with id: ${tabId}`);
          }
          return {
            id: tabId,
            status: 'complete',
            url: 'https://example.com/consent',
          };
        },
        remove: async () => {},
        update: async (tabId) => {
          if (!tabAlive) {
            throw new Error(`No tab with id: ${tabId}`);
          }
          return { id: tabId };
        },
      },
      webNavigation: {
        onBeforeNavigate: { addListener: () => {} },
        onCommitted: {
          addListener: (listener) => {
            navigationListener = listener;
          },
        },
      },
      webRequest: {
        onBeforeRequest: { addListener: () => {} },
      },
    },
    completeNodeFromBackground: async (_nodeId, payload) => {
      completedPayload = payload;
    },
    ensureContentScriptReadyOnTab: async () => {},
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        accessToken: 'access-token-002',
        refreshToken: 'refresh-token-002',
      }),
    }),
    getState: async () => currentState,
    getTabId: async () => 91,
    isTabAlive: async () => true,
    registerTab: async () => {},
    sendToContentScriptResilient: async (_source, message) => {
      if (message.type === 'GET_KIRO_DESKTOP_AUTHORIZE_STATE') {
        return {
          state: 'consent_page',
          url: 'https://example.com/consent',
        };
      }
      if (message.type === 'EXECUTE_KIRO_DESKTOP_AUTHORIZE_ACTION') {
        assert.equal(message.payload?.action, 'confirm-consent');
        tabAlive = false;
        setTimeout(() => {
          navigationListener?.({
            url: 'http://127.0.0.1:43121/oauth/callback?code=auth-code-002&state=desktop-state-002',
            tabId: 91,
          });
        }, 50);
        return {
          submitted: true,
          state: 'consent_submitted',
          url: 'https://example.com/consent',
        };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    },
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
    waitForTabStableComplete: async () => ({ status: 'complete' }),
  });

  await runner.executeKiroCompleteDesktopAuthorize(currentState);

  assert.equal(completedPayload?.kiroRuntime?.desktopAuth?.authorizationCode, 'auth-code-002');
  assert.equal(completedPayload?.kiroRuntime?.desktopAuth?.refreshToken, 'refresh-token-002');
});
