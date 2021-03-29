var fs = require('fs'),
	dns = require('dns'),
	zlib = require('zlib'),
	util = require('util'),
	path = require('path'),
	http = require('http'),
	https = require('https'),
	stream = require('stream'),
	crypto = require('crypto'),
	webpack = require('webpack'),
	webpack = require('webpack'),
	nodehttp = require('../nodehttp'),
	WebSocket = require('ws'),
	sqlite3 = class extends require('sqlite3').Database {
		constructor(...args){
			var callback = typeof args.slice(-1)[0] == 'function' && args.splice(-1)[0],
				promise = new Promise((resolve, reject) => super(...args, err => {
					var ind = this.wqueue.unknown.indexOf(promise);
					
					if(ind != -1)this.wqueue.unknown.splice(ind, 1);
					
					if(err)reject(err);
					else resolve();
				}));
			
			this.wqueue = { unknown: [ promise ] };
		}
		promisify(prop, [ query, ...args ]){
			var	split = query.split(' '),
				table = split.indexOf('from');
			
			if(table == -1)table = split.indexOf('into');
			
			if(table != -1)table = split[table + 1];
			else table = 'unknown';
			
			if(!this.wqueue[table])this.wqueue[table] = [];
			
			var promise = new Promise((resolve, reject) => Promise.allSettled(this.wqueue[table]).then(() => {
					var start = Date.now(), time;
					
					super[prop](query, ...args, (err, row, ind) => ((ind = this.wqueue[table].indexOf(promise)) != -1 && this.wqueue[table].splice(ind, 1), err ? reject(err) + console.error(query, '\n', err) : resolve(row)));
					
					time = Date.now() - start;
					
					// console.log(this.wqueue.length + ' - ' + time + ' MS - ' + args[0]);
					if(time > 100)console.log(query + '\ntook ' + time + 'ms to execute, consider optimizing');
				}));
			
			this.wqueue[table].push(promise);
			
			return promise;
		}
		get(...args){
			return this.promisify('get', args);
		}
		all(...args){
			return this.promisify('all', args);
		}
		run(...args){
			return this.promisify('run', args);
		}
	},
	data = new sqlite3(path.join(__dirname, 'data.db'));

module.exports = class extends require('./index.js') {
	constructor(config){
		super(Object.assign({
			http_agent: null,
			https_agent: new https.Agent({ rejectUnauthorized: false }),
		}, config));
		
		if(this.config.server){
			this.webpack = webpack({
				entry: path.join(__dirname, 'browser.js'),
				output: { path: path.join(__dirname, 'bundle'), filename: 'main.js' },
				devtool: 'source-map',
				plugins: [
					/*new webpack.SourceMapDevToolPlugin({
						filename: '[file].map',
					}),*/
					new webpack.DefinePlugin({
						PRODUCTION: true,
						inject_bundle_ts: this.bundle_ts,
						inject_config: JSON.stringify({
							codec: this.config.codec.name,
							prefix: this.config.prefix,
							title: this.config.title,
							ws: this.config.ws,
						}),
					}),
				],
			}, (err, stats) => {
				if(err)return console.error(err);
				
				this.webpack.watch({}, (err, stats) => {
					if(err)return console.error(err);
					this.bundle_ts = Date.now();
					console.log('Frontend bundled');
				});
			});
			
			this.config.server.use(this.config.prefix + '/', nodehttp.static(this.webpack.options.output.path, { listing: [ '/' ] }));
			
			this.config.server.use(this.config.prefix, async (req, res) => {
				if(req.url.searchParams.has('favicon'))return res.contentType('image/png').send(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAA', 'base64'));
				if(req.url.searchParams.has('cookie') && req.method == 'POST'){
					var meta = { id: req.cookies.proxy_id, url: this.valid_url(req.body.url) };
					
					if(!meta.url || !req.body.value)return res.cgi_error(400, 'Invalid body');
					
					if(!meta.id)res.headers.append('set-cookie', 'proxy_id=' + (meta.id = await this.bytes()) + '; expires=' + new Date(Date.now() + 54e8).toGMTString());
					
					await data.run(`create table if not exists "${meta.id}" (
						domain text primary key not null,
						value text,
						access integer not null
					)`);
					
					var existing = await data.run(`select * from "${meta.id}" where domain = ? or domain = ?`, meta.url.host, '.' + meta.url.host);
					
					existing = existing ? JSON.parse(existing.value) : {};
					
					nodehttp.cookies.parse(req.body.value).forEach(cookie => {
						var name = cookie.name;
						
						delete cookie.name;
						
						existing[name] = cookie;
					});
					
					await data.run(`insert or replace into "${meta.id}" (domain,value,access) values (?, ?, ?)`, meta.url.host, JSON.stringify(existing), Date.now());
					
					return res.status(200).end();
				}
				
				var url = this.valid_url(this.unurl(req.url.href, this.empty_meta)),
					meta = { url: url, origin: req.url.origin, base: url.origin, id: req.cookies.proxy_id },
					failure,
					timeout = setTimeout(() => !res.body_sent && (failure = true, res.cgi_error(500, 'Timeout')), this.config.timeout);
				
				// random secure id, expires after 2 months (54e8)+
				if(!meta.id)res.headers.append('set-cookie', 'proxy_id=' + (meta.id = await this.bytes()) + '; expires=' + new Date(Date.now() + 54e8).toGMTString());
				
				if(!url || !this.protocols.includes(url.protocol))return res.redirect('/');
				
				var ip = await dns.promises.lookup(url.hostname).catch(err => (failure = true, res.cgi_error(400, error)));
				
				if(failure)return;
				
				if(ip.address.match(this.regex.url.ip))return res.cgi_error(403, 'Forbidden IP');
				
				(url.protocol == 'http:' ? http : https).request({
					agent: url.protocol == 'http:' ? this.config.http_agent : this.config.https_agent,
					servername: url.hostname,
					hostname: ip.address,
					path: url.fullpath,
					port: url.port,
					protocol: url.protocol,
					localAddress: this.config.interface,
					headers: await this.headers_encode(req.headers, meta),
					method: req.method,
				}, async resp => {
					var dest = req.headers['sec-fetch-dest'],
						decoded = this.decode_params(req.url),
						content_type = (resp.headers['content-type'] || '').split(';')[0],
						route = decoded.get('route'),
						dec_headers = await this.headers_decode(resp.headers, meta);
					
					res.status(resp.statusCode.toString().startsWith('50') ? 400 : resp.statusCode);
					
					for(var name in dec_headers)res.set(name, dec_headers[name]);
					
					clearTimeout(timeout);
					
					if(failure)return;
					
					if(decoded.get('route') != 'false' && ['js', 'css', 'html', 'manifest'].includes(route)){
						var body = await this.decompress(req, resp);
						
						if(!body.byteLength)return res.send(body);
						
						if(this[route + '_async'])route += '_async';
						
						// console.time(route);
						
						var parsed = this[route](body.toString(), meta, { global: decoded.get('global') == true, mime: content_type });
						
						// console.timeEnd(route);
						
						if(parsed instanceof Promise)parsed = await parsed.catch(err => {
							console.error(err);
							
							return '<pre>' + nodehttp.sanitize(util.format(err)) + '</pre>';
						});
						
						res.send(parsed);
					}else{
						var encoding = resp.headers['content-encoding'] || resp.headers['x-content-encoding'];
						
						if(encoding)res.set('content-encoding', encoding);
						
						res.pipe_from(resp);
					}
				}).on('error', err => {
					clearTimeout(timeout);
					
					if(failure || res.body_sent || res.head_sent)return;
					
					res.cgi_error(400, err);
				}).end(req.raw_body);
			});
		}
		
		if(this.config.ws){
			var wss = new WebSocket.Server({ server: this.config.server.server });
			
			wss.on('connection', async (cli, req) => {
				var req_url = new this.URL(req.url, new this.URL('wss://' + req.headers.host)),
					url = this.unurl(req_url.href, this.empty_meta),
					cookies = nodehttp.cookies.parse_object(req.headers.cookie),
					meta = { url: url, origin: req_url, base: url, id: cookies.id };
				
				if(!url)return cli.close();
				
				var headers = await this.headers_encode(new nodehttp.headers(req.headers), meta),
					srv = new WebSocket(url, cli.protocol, {
						headers: headers,
						agent: ['wss:', 'https:'].includes(url.protocol) ? this.config.https_agent : this.config.http_agent,
					}),
					time = 8000,
					queue = [];
				
				srv.on('error', err => console.error(headers, url.href, util.format(err)) + cli.close());
				
				cli.on('message', data => {
					clearTimeout(timeout);
					
					timeout = setTimeout(() => srv.close(), time);
					
					if(srv.readyState == WebSocket.OPEN)srv.send(data);
				});
				
				cli.on('close', code => (srv.readyState == WebSocket.OPEN && srv.close()));
				
				srv.on('open', () => {
					cli.send('open');
					
					srv.on('message', data => cli.send(data));
				});
				
				srv.on('close', code => cli.close());
			});
		}
	}
	async headers_encode(value, meta){
		// prepare headers to be sent to a request url (eg google.com)
		
		// meta.id is hex, has no quotes so it can be wrapped in ""
		var out = {},
			existing = meta.id && await data.get(`select * from "${meta.id}" where domain = ? or domain = ?`, meta.url.host, '.' + meta.url.host).catch(err => {
				console.error(err);
				
				return false;
			}),
			cookies;
		
		out.cookie = nodehttp.cookies.format(Object.entries(existing ? JSON.parse(existing.value) : {}).map(([ key, val ]) => ({ name: key, value: val.value })));
		
		value.forEach((value, header) => {
			// val = typeof value[header] == 'object' ? value[header].join('') : value[header];
			
			switch(header.toLowerCase()){
				/*case'referrer':
				case'referer':
					
					// FIX
					out[header] = meta.origin.searchParams.has('ref') ? this.config.codec.decode(meta.origin.searchParams.get('ref'), meta) : this.valid_url(meta.url).href;
					
					break;*/
				case'host':
					
					out[header] = new this.URL(meta.url).host;
					
					break;
				case'cookie': case'sec-websocket-key': break;
				case'origin':
					
					/*
					FIX
					var url;

					url = this.valid_url(this.config.codec.decode(this.decode_params(data.origin).get('ref'), data));
					
					out.Origin = url ? url.origin : this.valid_url(data.url).origin;*/
					
					break;
				default:
					
					if(!header.match(this.regex.skip_header))out[header] = value;
					
					break;
			}
		});
		
		out['accept-encoding'] = 'gzip, deflate'; // , br
		
		out.host = new this.URL(meta.url).host;
		
		return out;
	}
	async headers_decode(value, meta){
		var out = {};
		
		for(var header in value){
			var val = typeof value[header] == 'object' ? value[header].join(', ') : value[header],
				arr = Array.isArray(value[header]) ? value[header] : [ value[header] ];
			
			switch(header.toLowerCase()){
				case'set-cookie':
					
					for(var ind = 0; ind < arr.length; ind++){
						await data.run(`create table if not exists "${meta.id}" (
							domain text primary key not null,
							value text,
							access integer not null
						)`);
						
						var existing = await data.run(`select * from "${meta.id}" where domain = ? or domain = ?`, meta.url.host, '.' + meta.url.host);
						
						existing = existing ? JSON.parse(existing.value) : {};
						
						nodehttp.cookies.parse(arr[ind]).forEach(cookie => {
							var name = cookie.name;
							
							delete cookie.name;
							
							existing[name] = cookie;
						});
						
						await data.run(`insert or replace into "${meta.id}" (domain,value,access) values (?, ?, ?)`, meta.url.host, JSON.stringify(existing), Date.now());
					};
					
					break;
				case'location':
					
					out[header] = this.url(val, meta, { route: 'html' });
					
					break;
				default:
					
					if(!header.match(this.regex.skip_header))out[header] = val;
					
					break;
			}
		};
		
		return out;
	}
decompress(req, res){
		var chunks = [];
		
		return new Promise((resolve, reject) => {
			if(req.method != 'HEAD' && res.statusCode != 204  && res.statusCode != 304)switch(res.headers['content-encoding'] || res.headers['x-content-encoding']){
				case'gzip':
					res = res.pipe(zlib.createGunzip({
						flush: zlib.Z_SYNC_FLUSH,
						finishFlush: zlib.Z_SYNC_FLUSH
					}));
					
					break;
				case'deflate':
					return res.once('data', chunk =>
						res.pipe((chunk[0] & 0x0F) === 0x08 ? zlib.createInflate() : zlib.createInflateRaw()).on('data', chunk => chunks.push(chunk)).on('end', () => resolve(Buffer.concat(chunks)))
					);
					
					break;
				case'br':
					res = res.pipe(zlib.createBrotliDecompress({
						flush: zlib.Z_SYNC_FLUSH,
						finishFlush: zlib.Z_SYNC_FLUSH
					}));
					
					break;
			}
			
			res.on('data', chunk => chunks.push(chunk)).on('end', () => resolve(Buffer.concat(chunks))).on('error', err => console.error(err) + resolve(Buffer.concat(chunks)));
		});
	}
	bytes(){
		return new Promise((resolve, reject) => crypto.randomBytes(32, (err, buf) => err ? reject(err) : resolve(buf.toString('hex'))));
	}
}