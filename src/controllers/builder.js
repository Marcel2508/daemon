'use strict';

/**
 * Pterodactyl - Daemon
 * Copyright (c) 2015 - 2016 Dane Everitt <dane@daneeveritt.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const rfr = require('rfr');
const Async = require('async');
const Fs = require('fs-extra');
const Path = require('path');
const Dockerode = require('dockerode');
const Util = require('util');
const RandomString = require('randomstring');
const _ = require('lodash');

const Log = rfr('src/helpers/logger.js');
const ImageHelper = rfr('src/helpers/image.js');
const InitializeHelper = rfr('src/helpers/initialize.js').Initialize;
const ConfigHelper = rfr('src/helpers/config.js');
const SFTPController = rfr('src/controllers/sftp.js');

const Config = new ConfigHelper();
const SFTP = new SFTPController();
const ServerInitializer = new InitializeHelper();
const DockerController = new Dockerode({
    socketPath: Config.get('docker.socket', '/var/run/docker.sock'),
});

class Builder {

    constructor(json) {
        if (!json || !_.isObject(json) || json === null || !_.keys(json).length) {
            throw new Error('Invalid JSON was passed to Builder.');
        }
        this.json = json;
        this.log = Log.child({ server: this.json.uuid });
    }

    init(next) {
        // @TODO: validate everything needed is here in the JSON.
        Async.series([
            callback => {
                this.log.info('Updating passed JSON to route correct interfaces.');
                // Update 127.0.0.1 to point to the docker0 interface.
                if (this.json.build.default.ip === '127.0.0.1') {
                    this.json.build.default.ip = Config.get('docker.interface');
                }
                Async.forEachOf(this.json.build.ports, (ports, ip, asyncCallback) => {
                    if (ip === '127.0.0.1') {
                        this.json.build.ports[Config.get('docker.interface')] = ports;
                        delete this.json.build.ports[ip];
                        return asyncCallback();
                    }
                    return asyncCallback();
                }, callback);
            },
            callback => {
                this.log.info('Creating SFTP user on the system...');
                SFTP.create(this.json.user, RandomString.generate(), callback);
            },
            callback => {
                this.log.info('Retrieving the user\'s ID...');
                SFTP.uid(this.json.user, (err, uid) => {
                    if (err || uid === null) {
                        SFTP.delete(this.json.user, delErr => {
                            if (delErr) Log.fatal(delErr);
                            Log.warn('Cleaned up after failed server creation.');
                        });
                        return (err !== null) ? callback(err) : callback(new Error('Unable to retrieve the user ID.'));
                    }
                    this.log.info(`User ID is: ${uid}`);
                    this.json.build.user = parseInt(uid, 10);
                    return callback();
                });
            },
            callback => {
                this.log.info('Building container for server');
                this.buildContainer(this.json.uuid, (err, data) => {
                    if (err) {
                        SFTP.delete(this.json.user, delErr => {
                            if (delErr) Log.fatal(delErr);
                            Log.warn('Cleaned up after failed server creation.');
                        });
                        return callback(err);
                    }
                    this.json.container = {};
                    this.json.container.id = data.id.substr(0, 12);
                    this.json.container.image = data.image;
                    return callback();
                });
            },
            callback => {
                this.log.info('Writing configuration to disk...');
                this.writeConfigToDisk(err => {
                    if (err) {
                        Async.parallel([
                            parallelCallback => {
                                SFTP.delete(this.json.user, parallelCallback);
                            },
                            parallelCallback => {
                                const container = DockerController.getContainer(this.json.container.id);
                                container.remove(parallelCallback);
                            },
                        ], asyncErr => {
                            if (asyncErr) {
                                Log.fatal(asyncErr);
                            } else {
                                Log.warn('Cleaned up after failed server creation.');
                            }
                        });
                    }
                    return callback(err);
                });
            },
            callback => {
                ServerInitializer.setup(this.json, err => {
                    if (err) {
                        Async.parallel([
                            parallelCallback => {
                                SFTP.delete(this.json.user, parallelCallback);
                            },
                            parallelCallback => {
                                const container = DockerController.getContainer(this.json.container.id);
                                container.remove(parallelCallback);
                            },
                            parallelCallback => {
                                Fs.remove(Path.join('./config/servers', this.json.uuid, '/server.json'), parallelCallback);
                            },
                        ], asyncErr => {
                            if (asyncErr) {
                                Log.fatal(asyncErr);
                            } else {
                                Log.warn('Cleaned up after failed server creation.');
                            }
                        });
                    }
                    return callback(err);
                });
            },
        ], err => {
            next(err, this.json);
        });
    }

    writeConfigToDisk(next) {
        if (_.isUndefined(this.json.uuid)) {
            return next(new Error('No UUID was passed properly in the JSON recieved.'));
        }
        // Attempt to write to disk, return error if failed, otherwise return nothing.
        Fs.outputJson(Path.join('./config/servers', this.json.uuid, '/server.json'), this.json, next);
    }

    buildContainer(json, next) {
        const config = this.json.build;
        const bindings = {};
        const exposed = {};
        Async.series([
            callback => {
                // The default is to not automatically update images.
                if (Config.get('docker.autoupdate_images', false) === false) {
                    ImageHelper.exists(config.image, err => {
                        if (!err) return callback();
                        Log.info(Util.format('Pulling image %s because it doesn\'t exist on the system.', config.image));
                        ImageHelper.pull(config.image, callback);
                    });
                } else {
                    ImageHelper.pull(config.image, callback);
                }
            },
            callback => {
                // Build the port bindings
                Async.forEachOf(config.ports, (ports, ip, eachCallback) => {
                    Async.each(ports, (port, portCallback) => {
                        bindings[Util.format('%s/tcp', port)] = [{
                            'HostIp': ip,
                            'HostPort': port.toString(),
                        }];
                        bindings[Util.format('%s/udp', port)] = [{
                            'HostIp': ip,
                            'HostPort': port.toString(),
                        }];
                        exposed[Util.format('%s/tcp', port)] = {};
                        exposed[Util.format('%s/udp', port)] = {};
                        portCallback();
                    }, eachCallback);
                }, callback);
            },
            callback => {
                // Add some additional environment variables
                config.env.SERVER_MEMORY = config.memory;
                config.env.SERVER_IP = config.default.ip;
                config.env.SERVER_PORT = config.default.port;

                const environment = [];
                _.forEach(config.env, (value, index) => {
                    environment.push(Util.format('%s=%s', index, value));
                });

                // How Much Swap?
                let swapSpace = 0;
                if (config.swap < 0) {
                    swapSpace = -1;
                } else if (config.swap > 0 && config.memory > 0) {
                    swapSpace = ((config.memory + config.swap) * 1000000);
                }
                // Make the container
                DockerController.createContainer({
                    Image: config.image,
                    Hostname: 'container',
                    User: config.user.toString(),
                    AttachStdin: true,
                    AttachStdout: true,
                    AttachStderr: true,
                    OpenStdin: true,
                    Tty: true,
                    Mounts: [
                        {
                            Source: Path.join(Config.get('sftp.path', '/srv/data'), this.json.user, '/data'),
                            Destination: '/home/container',
                            RW: true,
                        },
                    ],
                    Env: environment,
                    ExposedPorts: exposed,
                    HostConfig: {
                        Binds: [
                            Util.format('%s:/home/container', Path.join(Config.get('sftp.path', '/srv/data'), this.json.user, '/data')),
                        ],
                        PortBindings: bindings,
                        OomKillDisable: config.oom_disabled || false,
                        CpuQuota: (config.cpu > 0) ? (config.cpu * 1000) : -1,
                        CpuPeriod: (config.cpu > 0) ? 100000 : 0,
                        Memory: config.memory * 1000000,
                        MemorySwap: swapSpace,
                        BlkioWeight: config.io,
                        Dns: [
                            '8.8.8.8',
                            '8.8.4.4',
                        ],
                    },
                }, (err, container) => {
                    callback(err, container);
                });
            },
        ], (err, data) => {
            if (err) return next(err);
            return next(null, {
                id: data[2].id,
                image: config.image,
            });
        });
    }

}

module.exports = Builder;
