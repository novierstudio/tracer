import type { Ipv4Address } from '@/model';
import { THING_TYPES } from '@/model/iot';
import type { HttpResponse } from '../http';
import type { IpContext } from './context';
import { accountOpens, commandThing, liveThings } from './iot';

/**
 * The IoT server's web pages, as a Home Gateway and a server with IoT on serve them: a sign-in
 * form, then the list of registered things with their state and a link for each state an
 * actuator can take. A sign-in holds for the address it came from.
 */

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const STYLE = `body{font-family:sans-serif;margin:24px;color:#222}
h1{font-size:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
a{margin-right:6px}.on{font-weight:bold}.error{color:#b00}`;

function page(title: string, body: string): HttpResponse {
  return {
    kind: 'http',
    type: 'response',
    status: 200,
    reason: 'OK',
    contentType: 'text/html',
    body: `<!doctype html>
<html>
  <head><title>${escape(title)}</title><style>${STYLE}</style></head>
  <body>
${body}
  </body>
</html>
`,
  };
}

function signIn(ctx: IpContext, error?: string): HttpResponse {
  return page(
    'IoT Server - Device Login',
    `    <h1>IoT Server - ${escape(ctx.device.config.hostname)}</h1>
    ${error ? `<p class="error">${escape(error)}</p>` : ''}
    <form action="/login" method="get">
      <p><label>Username <input type="text" name="username"></label></p>
      <p><label>Password <input type="password" name="password"></label></p>
      <p><button type="submit">Sign In</button></p>
    </form>`,
  );
}

function deviceList(ctx: IpContext, username: string): HttpResponse {
  // A remote server shows each account its own things; a Home Gateway shows them all.
  const things = liveThings(ctx).filter(
    (thing) => ctx.device.kind !== 'server' || thing.owner === username,
  );
  const rows = things.map((thing) => {
    const type = THING_TYPES[thing.thing];
    const cells = type.attributes.map((attribute) => {
      const current = thing.state[attribute.key] ?? attribute.values[0]!;
      const controls =
        attribute.role === 'actuator'
          ? attribute.values
              .map((value) =>
                value === current
                  ? `<span class="on">${capitalize(value)}</span>`
                  : `<a href="/set?thing=${encodeURIComponent(thing.name)}&amp;key=${attribute.key}&amp;value=${value}">${capitalize(value)}</a>`,
              )
              .join(' ')
          : capitalize(current);
      return `${escape(attribute.label)}: ${controls}`;
    });
    return `      <tr><td>${escape(thing.name)}</td><td>${escape(type.label)}</td><td>${cells.join('<br>')}</td></tr>`;
  });
  return page(
    'IoT Server - Devices',
    `    <h1>IoT Server - Devices</h1>
    <p>Signed in as ${escape(username)}. <a href="/">Refresh</a> <a href="/logout">Sign Out</a></p>
    ${
      rows.length === 0
        ? '<p>No IoT devices have registered.</p>'
        : `<table>
      <tr><th>Name</th><th>Type</th><th>State</th></tr>
${rows.join('\n')}
    </table>`
    }`,
  );
}

/** The page for `path`, as the client at `client` sees it. */
export function iotPage(ctx: IpContext, client: Ipv4Address, path: string): HttpResponse {
  const [route = '/', query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const { sessions } = ctx.state.apps.iotServer;
  if (route === '/login') {
    const username = params.get('username') ?? '';
    if (!accountOpens(ctx, username, params.get('password') ?? '')) {
      return signIn(ctx, 'Invalid username or password.');
    }
    sessions.set(client, username);
    return deviceList(ctx, username);
  }
  if (route === '/logout') {
    sessions.delete(client);
    return signIn(ctx);
  }
  const username = sessions.get(client);
  if (username === undefined) return signIn(ctx);
  if (route === '/set') {
    commandThing(
      ctx,
      params.get('thing') ?? '',
      params.get('key') ?? '',
      params.get('value') ?? '',
    );
  }
  return deviceList(ctx, username);
}
