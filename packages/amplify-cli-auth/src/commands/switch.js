export default {
	desc: 'Select default account and organization',
	options: {
		'--account [name]':     'The account to switch to',
		'--json': {
			callback: ({ ctx, value }) => ctx.jsonMode = value,
			desc: 'Disables prompting and outputs selected account and org as JSON'
		},
		'--org [guid|id|name]': 'The organization to switch to'
	},
	async action({ argv, cli, console }) {
		const { default: snooplogg } = require('snooplogg');
		const { initSDK, isHeadless } = require('@axway/amplify-cli-utils');
		const { prompt } = require('enquirer');
		const { highlight } = snooplogg.styles;
		const { config, sdk } = initSDK({
			baseUrl:  argv.baseUrl,
			clientId: argv.clientId,
			env:      argv.env,
			realm:    argv.realm
		});
		const accounts = await sdk.auth.list();
		let account;

		if (!accounts.length) {
			throw new Error('No authenticated accounts found');
		}

		if (accounts.length > 1 && !argv.account && argv.json) {
			throw new Error('Must specify --account when --json is set and there are multiple authenticated accounts');
		}

		if (!argv.org && argv.json) {
			throw new Error('Must specify --org when --json is set');
		}

		if (argv.account) {
			account = await sdk.auth.find(argv.account);
			if (!account) {
				const err = new Error(`Account "${argv.account}" not found`);
				err.code = 'ERR_NOT_FOUND';
				err.details = `Authenticated accounts:\n${accounts.map(a => `  ${highlight(a.name)}`).join('\n')}`;
				throw err;
			}
		} else {
			// pick account from the list of of authenticated accounts
			let accountName = accounts[0]?.name;

			if (accounts.length > 1 && !argv.json) {
				// we have more than one authenticated account, so we must prompt for which account
				const defaultAccount = config.get('auth.defaultAccount');
				const choices = accounts
					.map(acct => ({ value: acct.name }))
					.sort((a, b) => a.value.localeCompare(b.value));
				const initial = choices.findIndex(a => a.value === defaultAccount);

				({ accountName } = await prompt({
					choices,
					initial,
					message: 'Please choose an account',
					name:    'accountName',
					type:    'select'
				}));

				console.log();
			}

			if (accountName) {
				account = await sdk.auth.find(accountName);
			}
		}

		account.default = true;
		config.set('auth.defaultAccount', account.name);
		config.delete(`auth.defaultOrg.${account.hash}`);
		config.save();

		if (account.isPlatform) {
			// determine the org
			let org = argv.org || (account?.hash && config.get(`auth.defaultOrg.${account.hash}`));
			let orgId;

			if (org) {
				for (const o of account.orgs) {
					if (o.guid === org || o.id === org || o.name === org) {
						orgId = o.id;
						break;
					}
				}
			}

			account = await sdk.auth.switchOrg(account, orgId, {
				onOpenBrowser() {
					if (isHeadless()) {
						throw new Error('Switching default account and organization requires a web browser and is unsupported in headless environments');
					} else if (!argv.json) {
						console.log('Launching web browser to switch organization...');
					}
				}
			});

			config.set(`auth.defaultOrg.${account.hash}`, account.org.guid);
			config.save();
		}

		await cli.emitAction('axway:auth:switch', account);

		if (argv.json) {
			console.log(JSON.stringify(account, null, 2));
		} else if (account.isPlatform && account.org?.name) {
			console.log(`Default account set to ${highlight(account.user.email || account.name)} in ${highlight(account.org.name)}`);
		} else {
			console.log(`Default account set to ${highlight(account.user.email || account.name)}`);
		}
	}
};
