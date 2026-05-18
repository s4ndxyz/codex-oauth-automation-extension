const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadPublisherApi() {
  const stateSource = fs.readFileSync('background/kiro/state.js', 'utf8');
  const publisherSource = fs.readFileSync('background/kiro/publisher-kiro-rs.js', 'utf8');
  const globalScope = {};
  new Function('self', `${stateSource}; ${publisherSource}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundKiroPublisherKiroRs;
}

test('kiro publisher exposes a factory and upload payload helpers', () => {
  const api = loadPublisherApi();
  assert.equal(typeof api?.createKiroRsPublisher, 'function');
  assert.equal(typeof api?.buildKiroRsPayload, 'function');
  assert.equal(typeof api?.buildMachineId, 'function');
});

test('kiro publisher builds kiro.rs payload from desktop auth runtime without profileArn', async () => {
  const api = loadPublisherApi();
  const payload = api.buildKiroRsPayload({
    kiroTargetId: 'kiro-rs',
    kiroRsUrl: 'https://kiro.example.com/admin',
    kiroRsKey: 'demo-key',
    ipProxyEnabled: true,
    ipProxyHost: '1.2.3.4',
    ipProxyPort: '8080',
    ipProxyProtocol: 'http',
    ipProxyUsername: 'proxy-user',
    ipProxyPassword: 'proxy-pass',
    kiroRuntime: {
      register: {
        email: 'aws-user@example.com',
      },
      desktopAuth: {
        region: 'us-east-1',
        clientId: 'client-001',
        clientSecret: 'secret-001',
        refreshToken: 'refresh-token-001',
      },
      upload: {
        targetId: 'kiro-rs',
      },
    },
  });
  const machineId = await api.buildMachineId('refresh-token-001');

  assert.deepEqual(payload, {
    targetId: 'kiro-rs',
    region: 'us-east-1',
    email: 'aws-user@example.com',
    refreshToken: 'refresh-token-001',
    clientId: 'client-001',
    clientSecret: 'secret-001',
    authMethod: 'idc',
    authRegion: 'us-east-1',
    apiRegion: 'us-east-1',
    proxyUrl: 'http://1.2.3.4:8080',
    proxyUsername: 'proxy-user',
    proxyPassword: 'proxy-pass',
  });
  assert.equal(machineId.length, 64);
  assert.match(machineId, /^[0-9a-f]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'profileArn'), false);
});

test('kiro publisher reads latest kiro.rs key from background state instead of stale node snapshot', async () => {
  const api = loadPublisherApi();
  const requests = [];
  let liveState = {
    kiroTargetId: 'kiro-rs',
    kiroRsUrl: 'https://kiro.example.com/admin',
    kiroRsKey: 'live-key',
    email: 'aws-user@example.com',
    kiroRuntime: {
      register: {
        email: 'aws-user@example.com',
      },
      desktopAuth: {
        region: 'us-east-1',
        clientId: 'client-001',
        clientSecret: 'secret-001',
        refreshToken: 'refresh-token-001',
      },
      upload: {
        targetId: 'kiro-rs',
      },
    },
    settingsState: {
      flows: {
        kiro: {
          targetId: 'kiro-rs',
          targets: {
            'kiro-rs': {
              baseUrl: 'https://kiro.example.com/admin',
              apiKey: 'live-key',
            },
          },
        },
      },
    },
  };
  const completed = [];
  const publisher = api.createKiroRsPublisher({
    addLog: async () => {},
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method || 'GET',
        apiKey: options.headers?.['x-api-key'],
      });
      if ((options.method || 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ items: [] }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          message: 'Credential uploaded.',
          credentialId: 9,
          email: 'aws-user@example.com',
        }),
      };
    },
    getState: async () => ({ ...liveState }),
    setState: async (updates = {}) => {
      liveState = { ...liveState, ...updates };
    },
  });

  await publisher.executeKiroUploadCredential({
    nodeId: 'kiro-upload-credential',
    kiroRsKey: '',
    settingsState: {
      flows: {
        kiro: {
          targetId: 'kiro-rs',
          targets: {
            'kiro-rs': {
              baseUrl: 'https://kiro.example.com/admin',
              apiKey: '',
            },
          },
        },
      },
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].apiKey, 'live-key');
  assert.equal(requests[1].apiKey, 'live-key');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'kiro-upload-credential');
});
