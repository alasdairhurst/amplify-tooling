import fs from 'fs';
import path from 'path';
import Router from '@koa/router';
import snooplogg from 'snooplogg';

const logger = snooplogg.config({
	minBrightness: 80,
	maxBrightness: 210,
	theme: 'detailed'
})('test-platform');
const { log } = logger;

export function createPlatformRoutes(server, opts = {}) {
	const router = new Router();
	const data = opts.data || JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json')));
	const state = opts.state || {};

	router.get('/v1/auth/findSession', async (ctx, next) => {
		const { authorization } = ctx.req.headers;
		const p = authorization ? authorization.indexOf(' ') : -1;
		const token = p !== -1 ? authorization.substring(p + 1) : null;

		log(`Finding session using token "${token}" or cookie "${ctx.cookies.get('connect.sid')}"`);

		if (!state.isServiceAccount && token === state.accessToken) {
			const user = data.users.find(u => u.guid === '50000');
			const orgs = data.orgs.filter(o => o.users.find(u => u.guid === user.guid));

			ctx.body = {
				success: true,
				result: {
					org: orgs[0],
					orgs,
					user
				}
			};
		} else if (state.isServiceAccount && token === state.accessToken) {
			ctx.body = {
				success: true,
				result: null
			};
		} else if (ctx.session?.userGuid) {
			const user = data.users.find(u => u.guid === ctx.session.userGuid);
			const orgs = data.orgs.filter(o => o.users.find(u => u.guid === user.guid));

			ctx.body = {
				success: true,
				result: {
					org: orgs[0],
					orgs,
					user
				}
			};
		} else {
			await next();
		}
	});

	router.post('/v1/auth/login', async ctx => {
		const { username, password } = ctx.request.body;

		const user = data.users.find(u => u.email === username);
		if (user && password === 'bar') {
			ctx.session.userGuid = user.guid;
			ctx.body = {
				success: true,
				result: user
			};
			return;
		}

		ctx.throw(401);
	});

	router.get('/v1/auth/logout', async ctx => {
		const { redirect } = ctx.query;
		if (redirect) {
			ctx.redirect(redirect);
		} else {
			ctx.body = {
				success: true,
				result: null
			};
		}
	});

	router.get('/v1/activity', ctx => {
		let { from, org_id, to, user_guid } = ctx.query;

		if (from) {
			from = Date.parse(from);
			if (isNaN(from)) {
				ctx.status = 400;
				ctx.body = 'Bad from date';
				return;
			}
		} else {
			from = Date.now() - (14 * 24 * 60 * 60 * 1000); // 14 days
		}

		if (to) {
			to = Date.parse(to);
			if (isNaN(to)) {
				ctx.status = 400;
				ctx.body = 'Bad to date';
				return;
			}
		} else {
			to = Date.now();
		}

		ctx.body = {
			success: true,
			result: data.activity.filter(a => {
				return a.ts >= from &&
					a.ts <= to &&
					(!org_id || String(a.org_id) === org_id) &&
					(!user_guid || a.user_guid === user_guid);
			})
		};
	});

	router.get('/v1/org/env', ctx => {
		ctx.body = {
			success: true,
			result: [
				{
					name: 'production',
					isProduction: true
				},
				{
					name: 'development',
					isProduction: false
				}
			]
		};
	});

	router.get('/v1/org/:id/family', ctx => {
		let org = data.orgs.find(o => String(o.org_id) === ctx.params.id);
		if (org?.parent_org_guid) {
			org = data.orgs.find(o => o.org_id === org.parent_org_guid);
		}
		if (org) {
			ctx.body = {
				success: true,
				result: {
					...org,
					children: org.children.map(c => data.orgs.find(o => o.guid === c))
				}
			};
		}
	});

	router.get('/v1/org/:id/usage', ctx => {
		const { id } = ctx.params;
		const org = data.orgs.find(o => String(o.org_id) === id || o.guid === id);
		if (org) {
			let { from, to } = ctx.query;

			if (from) {
				from = Date.parse(from);
				if (isNaN(from)) {
					ctx.status = 400;
					ctx.body = 'Bad from date';
					return;
				}
			} else {
				from = Date.now() - (14 * 24 * 60 * 60 * 1000); // 14 days
			}

			if (to) {
				to = Date.parse(to);
				if (isNaN(to)) {
					ctx.status = 400;
					ctx.body = 'Bad to date';
					return;
				}
			} else {
				to = Date.now();
			}

			const types = {
				apiRateMonth:      { name: 'API Calls', unit: 'Calls' },
				pushRateMonth:     { name: 'Push Notifications', unit: 'Calls' },
				storageFilesGB:    { name: 'File Storage', unit: 'GB' },
				storageDatabaseGB: { name: 'Database Storage', unit: 'GB' },
				containerPoints:   { name: 'Container Points', unit: 'Points' },
				eventRateMonth:    { name: 'Analytics Events', unit: 'Events' }
			};
			const usage = data.usage.find(u => u.org_guid === org.guid);
			const SaaS = {};

			for (const [ type, meta ] of Object.entries(types)) {
				SaaS[type] = {
					name: meta.name,
					quota: usage.quotas[type],
					value: 0,
					unit: meta.unit
				};
			}

			for (const evt of usage.events) {
				if (SaaS[evt.type] && evt.ts >= from && evt.ts <= to) {
					SaaS[evt.type].value += evt.value;
				}
			}

			ctx.body = {
				success: true,
				result: usage ? {
					...org,
					usage: { SaaS }
				} : null
			};
		}
	});

	router.get('/v1/org/:id/user', ctx => {
		let org = data.orgs.find(o => String(o.org_id) === ctx.params.id);
		if (org) {
			ctx.body = {
				success: true,
				result: org.users.reduce((users, ou) => {
					const user = data.users.find(u => u.guid === ou.guid);
					if (user) {
						users.push({
							...user,
							name: `${user.firstname} ${user.lastname}`.trim(),
							teams: data.teams.filter(t => t.users.find(u => u.guid === user.guid)).length,
							...ou
						});
					}
					return users;
				}, [])
			};
		}
	});

	router.post('/v1/org/:id/user', ctx => {
		let org = data.orgs.find(o => String(o.org_id) === ctx.params.id);
		if (org) {
			const { email, roles } = ctx.request.body;
			const user = data.users.find(u => u.email === email || u.guid === email);

			if (!user) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: 'User not found'
				};
				return;
			}

			if (org.users.find(u => u.guid === user.guid)) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: 'User is already a member of this org.'
				};
				return;
			}

			org.users.push({
				guid: user.guid,
				roles,
				primary: true
			})

			ctx.body = {
				success: true,
				result: { guid: user.guid }
			};
		}
	});

	router.delete('/v1/org/:id/user/:user_guid', ctx => {
		let org = data.orgs.find(o => String(o.org_id) === ctx.params.id);
		if (org) {
			const { user_guid } = ctx.params;
			const idx = org.users.findIndex(u => u.guid === user_guid);

			if (idx === -1) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: `"user_guid" contained an invalid value.`
				};
				return;
			}

			org.users.splice(idx, 1);

			ctx.body = {
				success: true,
				result: {}
			};
		}
	});

	router.put('/v1/org/:id/user/:user_guid', ctx => {
		let org = data.orgs.find(o => String(o.org_id) === ctx.params.id);
		if (org) {
			const { user_guid } = ctx.params;
			const user = org.users.find(u => u.guid === user_guid);

			if (!user) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: `"user_guid" contained an invalid value.`
				};
				return;
			}

			user.roles = ctx.request.body.roles;

			ctx.body = {
				success: true,
				result: null
			};
		}
	});

	router.get('/v1/org/:id', ctx => {
		const { id } = ctx.params;
		const org = data.orgs.find(o => String(o.org_id) === id || o.guid === id);
		if (org) {
			ctx.body = {
				success: true,
				result: org
			};
		}
	});

	router.put('/v1/org/:id', ctx => {
		const { id } = ctx.params;
		const org = data.orgs.find(o => String(o.org_id) === id || o.guid === id);
		if (org) {
			org.name = ctx.request.body.name;
			ctx.body = {
				success: true,
				result: org
			};
		}
	});

	router.get('/v1/role', ctx => {
		const { team } = ctx.query;
		ctx.body = {
			success: true,
			result: data.roles.filter(r => team ? r.team : r.org)
		};
	});

	router.delete('/v1/team/:guid/user/:user_guid', ctx => {
		const team = data.teams.find(t => t.guid === ctx.params.guid);
		if (team) {
			const idx = team.users.findIndex(u => u.guid === ctx.params.user_guid);

			if (idx === -1) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: `"user_guid" contained an invalid value.`
				};
				return;
			}

			team.users.splice(idx, 1);

			ctx.body = {
				success: true,
				result: {}
			};
		}
	});

	router.post('/v1/team/:guid/user/:user_guid', ctx => {
		const team = data.teams.find(t => t.guid === ctx.params.guid);
		if (team) {
			const user = data.users.find(u => u.guid === ctx.params.user_guid);

			if (!user) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: 'User not found'
				};
				return;
			}

			if (team.users.find(u => u.guid === user.guid)) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: 'User is already a member of this team.'
				};
				return;
			}

			if (!Array.isArray(team.users)) {
				team.users = [];
			}

			team.users.push({
				guid: user.guid,
				roles: ctx.request.body.roles,
				primary: true
			})

			ctx.body = {
				success: true,
				result: team
			};
		}
	});

	router.put('/v1/team/:guid/user/:user_guid', ctx => {
		const team = data.teams.find(t => t.guid === ctx.params.guid);
		if (team) {
			const user = team.users.find(u => u.guid === ctx.params.user_guid);

			if (!user) {
				ctx.status = 400;
				ctx.body = {
					success: false,
					message: `"user_guid" contained an invalid value.`
				};
				return;
			}

			user.roles = ctx.request.body.roles;

			ctx.body = {
				success: true,
				result: team
			};
		}
	});

	router.delete('/v1/team/:guid', ctx => {
		const idx = data.teams.findIndex(t => t.guid === ctx.params.guid);
		if (idx !== -1) {
			data.teams.splice(idx, 1);
			ctx.body = {
				success: true,
				result: {}
			};
		}
	});

	router.get('/v1/team/:guid', ctx => {
		const team = data.teams.find(t => t.guid === ctx.params.guid);
		if (team) {
			ctx.body = {
				success: true,
				result: team
			};
		}
	});

	router.put('/v1/team/:guid', ctx => {
		const team = data.teams.find(t => t.guid === ctx.params.guid);
		if (team) {
			const info = ctx.request.body;

			if (info.name !== undefined) {
				team.name = info.name;
			}
			if (info.default !== undefined) {
				team.default = !!info.default;
			}
			if (info.desc !== undefined) {
				team.desc = info.desc;
			}
			if (info.tags !== undefined) {
				team.tags = info.tags;
			}

			ctx.body = {
				success: true,
				result: team
			};
		}
	});

	router.get('/v1/team', ctx => {
		let { teams } = data;

		const { name, org_id } = ctx.query;
		if (org_id) {
			const org = data.orgs.find(o => String(o.org_id) === org_id);
			if (!org) {
				return;
			}
			teams = teams.filter(t => t.org_guid === org.guid &&
				(!name || t.name.toLowerCase().includes(String(name).trim().toLowerCase())));
		}

		ctx.body = {
			success: true,
			result: teams
		};
	});

	router.post('/v1/team', ctx => {
		const info = ctx.request.body
		const org = data.orgs.find(o => o.guid === info.org_guid);

		if (!org) {
			throw new Error('Org not found');
		}

		const team = {
			name:     info.name,
			guid:     uuidv4(),
			default:  info.default === undefined ? true : !!info.default,
			desc:     info.desc,
			tags:     info.tags === undefined ? [] : info.tags,
			org_guid: info.org_guid,
			users:    []
		};

		data.teams.push(team);

		ctx.body = {
			success: true,
			result: team
		};
	});

	router.put('/v1/user/profile/:id', ctx => {
		const { id } = ctx.params;
		const user = data.users.find(u => u.guid === id);
		if (user) {
			const { firstname, lastname, phone } = ctx.request.body;

			if (firstname) {
				user.firstname = firstname;
			}
			if (lastname) {
				user.lastname = lastname;
			}
			if (phone) {
				user.phone = phone;
			}

			ctx.body = {
				success: true,
				result: user
			};
		}
	});

	router.get('/v1/user/:id', ctx => {
		const { id } = ctx.params;
		const user = data.users.find(u => u.guid === id);
		if (user) {
			ctx.body = {
				success: true,
				result: user
			};
		}
	});

	router.get('/v1/user', ctx => {
		const { term } = ctx.query;
		if (term) {
			ctx.body = {
				success: true,
				result: data.users.filter(u => u.email === term)
			};
		}
	});

	server.router.use('/api', router.routes());

	server.router.get('/signed.out', ctx => {
		ctx.body = `<html>
<head>
<title>Logout successful!</title>
</head>
<body>
<h1>You have logged out</h1>
<p>Have a nice day!</p>
</body>
</html>`;
	})

	server.router.get([ '/', '/success' ], ctx => {
		ctx.body = `<html>
<head>
<title>Test successful!</title>
</head>
<body>
<h1>Test successful!</h1>
<p>You can close this browser window</p>
<script>
let u = new URL(location.href);
let m = u.hash && u.hash.match(/redirect=(.+)/);
if (m) {
	location.href = decodeURIComponent(m[1]);
}
</script>
</body>
</html>`;
	});
}
