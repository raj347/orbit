'use strict';

const _           = require('lodash');
const fs          = require('fs');
const path        = require('path');
const assert      = require('assert');
const Promise     = require('bluebird')
const ipfsd       = require('ipfsd-ctl');
const IPFS        = require('ipfs')
const OrbitServer = require('orbit-server/src/server');
const EventStore  = require('orbit-db-eventstore');
const Post        = require('ipfs-post');
const Orbit       = require('../src/Orbit');

// Mute logging
require('logplease').setLogLevel('ERROR');

// Orbit
const network = 'localhost:3333';
const username = 'testrunner';
const password = '';

let ipfs, ipfsDaemon;
const IpfsApis = [
// {
//   // js-ipfs
//   name: 'js-ipfs',
//   start: () => {
//     return new Promise((resolve, reject) => {
//       const ipfs = new IPFS('/tmp/orbit-tests');
//       ipfs.init({}, (err) => {
//         if(err) {
//           if(err.message === 'repo already exists')
//             return resolve(ipfs);
//           return reject(err);
//         }
//         ipfs.goOnline((err) => {
//           if(err) reject(err)
//           resolve(ipfs)
//         });
//       });
//     });
//   },
//   // stop: () => Promise.resolve()
//   stop: () => new Promise((resolve, reject) => {
//     if(!ipfs._bitswap && !ipfs._libp2pNode)
//       resolve();
//     ipfs.goOffline((err) => {
//       if(err) console.log("Error", err)
//       resolve();
//     })
//   })
// },
{
  // js-ipfs-api via local daemon
  name: 'js-ipfs-api',
  start: () => {
    return new Promise((resolve, reject) => {
      ipfsd.disposableApi((err, ipfs) => {
        if(err) reject(err);
        resolve(ipfs);
      });
      // ipfsd.local((err, node) => {
      //   if(err) reject(err);
      //   ipfsDaemon = node;
      //   ipfsDaemon.startDaemon((err, ipfs) => {
      //     if(err) reject(err);
      //     resolve(ipfs);
      //   });
      // });
    });
  },
  stop: () => Promise.resolve()
  // stop: () => new Promise((resolve, reject) => ipfsDaemon.stopDaemon(resolve)) // for use with local daemon
}
];

OrbitServer.start();

IpfsApis.forEach(function(ipfsApi) {

  describe('Orbit with ' + ipfsApi.name, function() {
    this.timeout(10000);

    let orbit, client, client2;
    let channel = 'orbit-test';
    // const cacheFile = path.join(process.cwd(), '/test', 'orbit-db-test-cache.json');

    before(function (done) {
      ipfsApi.start()
        .then((res) => {
          ipfs = res;
          done();
        })
        .catch(done);
    });

    after((done) => {
      if(orbit)
        orbit.disconnect();

      orbit = null;

      if(ipfs) {
        ipfsApi.stop()
          .then(done)
          .catch(done);
      }
    });

    describe('constructor', function() {
      it('creates an instance', () => {
        orbit = new Orbit(ipfs);
        assert.notEqual(orbit, null);
        assert.notEqual(orbit.ipfs, null);
        assert.equal(orbit.orbitdb, null);
        assert.equal(orbit.options.maxHistory, 64);
        assert.notEqual(orbit.options.cacheFile, null);
        assert.equal(Object.keys(orbit._channels).length, 0);
      });

      it('creates an instance with options', () => {
        orbit = new Orbit(ipfs, { cacheFile: null, maxHistory: 0 });
        assert.equal(orbit.orbitdb, null);
        assert.equal(orbit.options.maxHistory, 0);
        assert.equal(orbit.options.cacheFile, null);
      });
    });

    describe('connect', function() {
      it('connects to a network', (done) => {
        orbit = new Orbit(ipfs);
        orbit.connect(network, username, password)
          .then((res) => {
            assert.notEqual(orbit.orbitdb, null);
            assert.equal(orbit.orbitdb.events.listenerCount('data'), 1);
            assert.equal(orbit.orbitdb.events.listenerCount('load'), 1);
            assert.equal(orbit.orbitdb.events.listenerCount('ready'), 1);
            assert.equal(orbit.orbitdb.events.listenerCount('sync'), 1);
            assert.equal(orbit.orbitdb.events.listenerCount('synced'), 1);
            orbit.disconnect();
            done();
          })
          .catch(done)
      });

      it('handles connection error', () => {
        orbit = new Orbit(ipfs);
        return orbit.connect('abc', username, password)
          .catch((e) => {
            assert.notEqual(e, null);
            assert.equal(orbit.orbitdb, null);
            // assert.equal(e.message, 'Invalid Key'); // js-ipfs
            assert.equal(e.message, "Connection refused to Pubsub at 'abc:undefined'"); // js-ipfs-api
          })
      });

      it('emits \'connected\' event when connected to a network', (done) => {
        orbit = new Orbit(ipfs);
        orbit.events.on('connected', (networkInfo, userInfo) => {
          assert.notEqual(networkInfo, null);
          assert.notEqual(userInfo, null);
          assert.equal(networkInfo.name, 'Orbit DEV Network');
          assert.equal(networkInfo.publishers.length, 1);
          assert.equal(networkInfo.publishers[0], 'localhost:3333');
          assert.equal(userInfo.username, username);
          assert.equal(userInfo.id, username);
          done();
        });
        return orbit.connect(network, username, password).catch(done)
      });
    });

    describe('disconnect', function() {
      it('disconnects from a network', (done) => {
        orbit = new Orbit(ipfs);
        orbit.connect(network, username, password)
          .then((res) => {
            orbit.disconnect();
            assert.equal(orbit.orbitdb, null);
            assert.equal(_.isEqual(orbit._channels, {}), true);
            done();
          })
          .catch(done)
      });

      it('emits \'disconnected\' event when disconnected from a network', (done) => {
        orbit = new Orbit(ipfs);
        orbit.connect(network, username, password)
          .then(() => {
            orbit.events.on('disconnected', (networkInfo, userInfo) => {
              assert.equal(orbit.network, null);
              assert.equal(orbit.user, null);
              done();
            });
          })
          .then(() => orbit.disconnect())
          .catch(done)
      });
    });

    describe('join', function() {
      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null, maxHistory: 0 });
        orbit.connect(network, username, password)
          .then((res) => done())
          .catch(done)
      });

      afterEach(() => {
        orbit.disconnect();
      });

      it('joins a new channel', () => {
        const channel = 'test1';
        return orbit.join(channel).then((result) => {
          const channels = orbit.channels;
          assert.equal(result, true);
          assert.equal(channels.length, 1);
          assert.equal(channels[0].name, channel);
          assert.equal(channels[0].password, null);
          assert.notEqual(channels[0].db, null);
          assert.equal(channels[0].state.loading, false);
          assert.equal(channels[0].state.syncing, 0);
          assert.notEqual(orbit._channels[channel], null);
        });
      });

      it('joins an existing channel', () => {
        const channel = 'test1';
        return orbit.join(channel)
          .then(() => orbit.join(channel))
          .then((result) => {
            const channels = orbit.channels;
            assert.equal(result, false);
            assert.equal(channels.length, 1);
            assert.equal(channels[0].name, channel);
            assert.equal(channels[0].password, null);
            assert.notEqual(channels[0].db, null);
            assert.equal(channels[0].state.loading, false);
            assert.equal(channels[0].state.syncing, 0);
          });
      });

      it('joins another new channel', () => {
        const channel1 = 'test1';
        const channel2 = 'test2';
        return orbit.join(channel1)
          .then(() => orbit.join(channel2))
          .then((result) => {
            const channels = orbit.channels;
            assert.equal(result, true);
            assert.equal(channels.length, 2);
            assert.equal(channels[0].name, channel1);
            assert.equal(channels[0].password, null);
            assert.equal(channels[0].state.loading, false);
            assert.equal(channels[0].state.syncing, 0);
            assert.notEqual(channels[0].db, null);
            assert.equal(channels[1].name, channel2);
            assert.equal(channels[1].password, null);
            assert.equal(channels[1].state.loading, false);
            assert.equal(channels[1].state.syncing, 0);
            assert.notEqual(channels[1].db, null);
          });
      });

      it('returns \'true\' when a new channel was joined', () => {
        const channel = 'test1';
        return orbit.join(channel).then((result) => {
          assert.equal(result, true);
        });
      });

      it('returns \'false\' when an excisting channel was joined', () => {
        const channel = 'test1';
        return orbit.join(channel)
          .then(() => orbit.join(channel))
          .then((result) => {
            assert.equal(result, false);
          });
      });

      it('emits \'joined\' event after joining a new channel', (done) => {
        const channel = 'test1';
        orbit.events.once('joined', (channelName) => {
          const channels = orbit.channels;
          assert.equal(channelName, channel);
          assert.equal(channels.length, 1);
          assert.equal(channels[0].name, channel);
          assert.equal(channels[0].password, null);
          assert.notEqual(channels[0].db, null);
          assert.equal(channels[0].state.loading, false);
          assert.equal(channels[0].state.syncing, 0);
          assert.notEqual(orbit._channels[channel], null);
          done();
        });
        orbit.join(channel).catch(done);
      });

      it('doesn\'t emit \'joined\' event after joining an existing channel', (done) => {
        const channel = 'test1';
        orbit.join(channel).then(() => {
          setTimeout(() => done(), 1000);
          orbit.events.on('joined', () => done(new Error("'joined' event was emitted")));
          orbit.join(channel);
        }).catch(done);
      });

      it('throws an error when channel is not specified', (done) => {
        orbit.join()
          .then((post) => done(new Error("Channel was not specified!")))
          .catch((e) => {
            assert.equal(e.toString(), `Channel not specified`);
            done();
          })
      });

      // it('emits \'ready\' event after joining an existing channel', (done) => {
      //   const channel = 'test1';
      //   orbit.join(channel).then(() => {
      //     orbit.events.on('ready', (channelName) => {
      //       const channels = orbit.channels;
      //       assert.equal(channelName, channel);
      //       assert.equal(channels[0].name, channel);
      //       assert.equal(channels[0].password, null);
      //       assert.notEqual(channels[0].db, null);
      //       assert.equal(channels[0].state.loading, false);
      //       assert.equal(channels[0].state.syncing, 0);
      //       assert.notEqual(orbit._channels[channel], null);
      //       assert.equal(channels.length, 1);
      //       done();
      //     });
      //     orbit.join(channel);
      //   }).catch(done);
      // });
    });

    describe('leave', function() {
      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null });
        orbit.connect(network, username, password)
          .then((res) => done())
          .catch(done)
      });

      it('leaves a channel', (done) => {
        const channel = 'test1';
        orbit.join(channel).then(() => {
          orbit.leave(channel);
          const channels = orbit.channels;
          assert.equal(channels.length, 0);
          assert.equal(orbit.channels[channel], null);
          done();
        });
      });

      it('emits \'left\' event after leaving channel', (done) => {
        const channel = 'test1';
        orbit.join(channel).then(() => {
          orbit.events.on('left', (channelName) => {
            assert.equal(channelName, channel);
            assert.equal(orbit.channels.length, 0);
            done();
          });
          orbit.leave(channel);
        });
      });

      it('emits \'left\' event after calling leave if channels hasn\'t been joined', (done) => {
        const channel = 'test1';
        orbit.events.on('left', (channelName) => {
          assert.equal(channelName, channel);
          assert.equal(orbit.channels.length, 0);
          done();
        });
        orbit.leave(channel);
      });
    });

    describe('getters', function() {
      describe('defaults', function() {
        before(() => {
          orbit = new Orbit(ipfs, { cacheFile: null });
        });

        it('no users', () => {
          assert.equal(orbit.user, null);
        });
        it('no network', () => {
          assert.equal(orbit.network, null);
        });
        it('no channels', () => {
          assert.equal(orbit.channels.length, 0);
        });
        it('no peers', () => {
          assert.equal(orbit.peers.length, 0);
        });
      });
      describe('return', function() {
        before((done) => {
          orbit = new Orbit(ipfs, { cacheFile: null });
          orbit.connect(network, username, password)
            .then((res) => done())
            .catch(done)
        });

        after(() => {
          orbit.disconnect();
        });

        it('user', () => {
          assert.notEqual(orbit.user, null);
          assert.equal(orbit.user.username, username);
          assert.equal(orbit.user.id, username);
        });

        it('network', () => {
          assert.notEqual(orbit.network, null);
          assert.equal(orbit.network.publishers.length, 1);
        });

        it.skip('peers', () => {
          // TODO
        });

        describe('channels', function() {
          it('returns a joined channel', () => {
            const channel = 'test2';
            return orbit.join(channel).then(() => {
              assert.equal(orbit.channels.length, 1);
              assert.equal(orbit.channels[0].name, channel);
            })
          });

          it('returns the channels in correcy format', () => {
            const channel = 'test1';
            return orbit.join(channel).then(() => {
              const channels = orbit.channels;
              assert.equal(orbit.channels.length, 2);
              assert.equal(channels[1].name, channel);
              assert.equal(channels[1].password, null);
              assert.equal(Object.prototype.isPrototypeOf(channels[1].db, EventStore), true);
              assert.equal(channels[1].state.loading, false);
              assert.equal(channels[1].state.syncing, 0);
            });
          });
        });
      });
    });

    describe('send', function() {
      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null, maxHistory: 0 });
        orbit.connect(network, username, password)
          .then((res) => done())
          .catch(done)
      });

      afterEach(() => {
        orbit.disconnect();
      });

      it('sends a message to a channel', (done) => {
        const channel = 'test1';
        const content = 'hello1';
        orbit.join(channel)
          .then(() => orbit.send(channel, content))
          .then((message) => {
            setTimeout(() => {
              const messages = orbit.get(channel);
              assert.equal(messages.length, 1);
              assert.equal(messages[0].payload.op, 'ADD');
              assert.equal(messages[0].payload.value, message.Hash);
              assert.notEqual(messages[0].payload.meta, null);
              assert.notEqual(messages[0].payload.meta.ts, null);
              assert.equal(messages[0].hash.startsWith('Qm'), true);
              assert.equal(messages[0].next.length, 0);
              done();
            }, 1000);
          })
          .catch(done)
      });

      it('returns a Post', (done) => {
        const channel = 'test1';
        const content = 'hello' + new Date().getTime();
        orbit.join(channel)
          .then(() => orbit.send(channel, content))
          .then((message) => {
            setTimeout(() => {
              assert.notEqual(message.Post, null);
              assert.equal(message.Hash.startsWith('Qm'), true);
              assert.equal(message.Post.content, content);
              assert.equal(Object.keys(message.Post.meta).length, 4);
              assert.equal(message.Post.meta.type, "text");
              assert.equal(message.Post.meta.size, 15);
              assert.equal(message.Post.meta.from, username);
              assert.notEqual(message.Post.meta.ts, null);
              done();
            }, 1000);
          })
          .catch(done)
      });

      it('Post was added to IPFS', (done) => {
        const channel = 'test1';
        const content = 'hello' + new Date().getTime();
        orbit.join(channel)
          .then(() => orbit.send(channel, content))
          .then((message) => orbit.getPost(message.Hash))
          .then((data) => {
            setTimeout(() => {
              assert.equal(data.content, content);
              assert.equal(data.meta.type, "text");
              assert.equal(data.meta.size, 15);
              assert.notEqual(data.meta.ts, null);
              assert.equal(data.meta.from, username);
              done();
            }, 1000);
          })
          .catch(done)
      });

      it('throws an error when channel is not specified', (done) => {
        const channel = 'test1';
        orbit.join(channel)
          .then(() => orbit.send())
          .then((post) => done(new Error("Channel was not specified!")))
          .catch((e) => {
            assert.equal(e.toString(), `Channel not specified`);
            done();
          })
      });

      it('throws an error when trying to send a message to channel that hasn\'t been joined', (done) => {
        const channel = 'test1';
        const content = 'hello1';
        orbit.send(channel, content)
          .then((post) => done(new Error(`Not joined on #${channel} but the message was sent!`)))
          .catch((e) => {
            assert.equal(e.toString(), `Can't send the message, not joined on #${channel}`);
            done();
          })
      });

      it('throws an error when trying to send an empty message', (done) => {
        const channel = 'test1';
        const content = '';
        orbit.join(channel)
          .then(() => orbit.send(channel, content))
          .then((post) => done(new Error("Empty message was sent!")))
          .catch((e) => {
            assert.equal(e.toString(), `Can't send an empty message`);
            done();
          })
      });

      it('throws an error when message is not specified', (done) => {
        const channel = 'test1';
        orbit.join(channel, null)
          .then(() => orbit.send(channel))
          .then((post) => done(new Error("Empty message was sent!")))
          .catch((e) => {
            assert.equal(e.toString(), `Can't send an empty message`);
            done();
          })
      });
    });

    describe('get', function() {
      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null, maxHistory: 0 });
        orbit.connect(network, username, password)
          .then((res) => done())
          .catch(done)
      });

      afterEach(() => {
        orbit.disconnect();
      });

      it('returns the latest message', (done) => {
        const channel = 'test1';
        const ts = new Date().getTime();
        const content = 'hello' + ts;
        orbit.join(channel)
          .then(() => orbit.send(channel, content))
          .then((message) => {
            setTimeout(() => {
              const messages = orbit.get(channel, null, null, 10);
              assert.equal(messages.length, 1);
              assert.equal(messages[0].payload.op, 'ADD');
              assert.equal(messages[0].payload.value, message.Hash);
              assert.notEqual(messages[0].payload.meta, null);
              assert.notEqual(messages[0].payload.meta.ts, null);
              assert.equal(messages[0].hash.startsWith('Qm'), true);
              assert.equal(messages[0].next.length, 0);
              done();
            }, 1000);
          })
          .catch(done)
      });

      it('returns all messages in the right order', (done) => {
        const channel = 'test12345';
        const content = 'hello';
        orbit.join(channel)
          .then(() => {
            return Promise.mapSeries([1, 2, 3, 4, 5], (i) => orbit.send(channel, content + i), { concurrency: 1 })
          })
          .then((result) => {
            setTimeout(() => {
              const messages = orbit.get(channel, null, null, -1);
              assert.equal(messages.length, 5);
              messages.forEach((msg, index) => {
                assert.equal(msg.payload.op, 'ADD');
                assert.equal(msg.payload.value, result[index].Hash);
                assert.notEqual(msg.payload.meta, null);
                assert.notEqual(msg.payload.meta.ts, null);
                assert.equal(msg.hash.startsWith('Qm'), true);
                assert.equal(msg.next.length, index === 0 ? 0 : 1);
              });
              done();
            }, 4000);
          })
          .catch(done)
      });

      it('throws an error if trying to get from a channel that hasn\'t been joined', (done) => {
        const channel = 'test1';
        try {
          const messages = orbit.get(channel);
        } catch(e) {
          assert.equal(e, `Not joined on #${channel}`);
          done();
        }
      });
    });

    describe('getPost', function() {
      const channel = 'test1';
      const content = 'hello' + new Date().getTime();
      let message;

      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null, maxHistory: 0 });
        orbit.connect(network, username, password)
          .then((res) => orbit.join(channel))
          .then(() => orbit.send(channel, content))
          .then((res) => message = res)
          .then(() => done())
          .catch(done)
      });

      afterEach(() => {
        orbit.disconnect();
      });

      it('returns a Post', (done) => {
        orbit.join(channel)
          .then(() => orbit.getPost(message.Hash))
          .then((data) => {
            setTimeout(() => {

              assert.equal(data.content, content);
              assert.equal(data.meta.type, "text");
              assert.equal(data.meta.size, 15);
              assert.notEqual(data.meta.ts, null);
              assert.equal(data.meta.from, username);
              done();
            }, 1000);
          })
          .catch(done)
      });

      it('throws an error when trying to get a Post with invalid hash', (done) => {
        orbit.getPost("Qm...Foo")
          .catch((e) => {
            assert.equal(e.message, "invalid ipfs ref path");
            done();
          })
      });

      // Enable this test when ipfs can timeout
      it.skip('throws an error when Post doesn\'t exist', (done) => {
        orbit.getPost("QmQMhG5f8PPPaxYWhFPZxteEZfCMpCv9k4WmRd8VdTN7p2")
          .catch((e) => {
            assert.equal(e.message, "invalid ipfs ref path");
            done();
          })
      });
    });

    describe('addFile', function() {
      const channel = 'test1';

      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null, maxHistory: 0 });
        orbit.connect(network, username, password)
          .then((res) => orbit.join(channel))
          .then(() => done())
          .catch(done)
      });

      afterEach(() => {
        orbit.disconnect();
      });

      it('adds a file', (done) => {
        const filename = 'mocha.opts';
        orbit.join(channel)
          .then(() => orbit.addFile(channel, path.join(process.cwd(), '/test' , filename)))
          .then((res) => {
            assert.notEqual(res.Post, null);
            assert.equal(res.Hash.startsWith('Qm'), true);
            assert.equal(res.Post.name, filename);
            assert.equal(res.Post.size, 68);
            assert.equal(Object.keys(res.Post.meta).length, 4);
            assert.equal(res.Post.meta.size, 68);
            assert.equal(res.Post.meta.from, username);
            assert.notEqual(res.Post.meta.ts, null);
            done();
          })
          .catch(done)
      });

      it.skip('adds a directory recursively', (done) => {
        done();
      });

      it.skip('throws an error if channel parameter is not given', (done) => {
        done();
      });

      it.skip('throws an error if channel parameter is not given', (done) => {
        done();
      });

      it.skip('throws an error if filePath parameter is not given', (done) => {
        done();
      });

      it.skip('throws an error if not joined on channel', (done) => {
        done();
      });

    });

    describe('events', function() {
      beforeEach((done) => {
        orbit = new Orbit(ipfs, { cacheFile: null });
        orbit.connect(network, username, password)
          .then((res) => done())
          .catch(done)
      });

      afterEach(() => {
        orbit.disconnect();
      });

      it('emits \'data\'', (done) => {
        const channel = 'test1';
        orbit.events.on('data', (channelName, messageHash) => {
          assert.equal(channelName, channel);
          assert.equal(messageHash.startsWith('Qm'), true);
          done();
        });
        orbit.join(channel).then(() => orbit.send(channel, 'hello'));
      });

      it('emits \'load\'', (done) => {
        const channel = 'test1';
        orbit.events.on('load', (channelName) => {
          assert.equal(channelName, channel);
          done();
        });
        orbit.join(channel);
      });

      it('emits \'state.updated\' on load', (done) => {
        const channel = 'test1';
        orbit.events.once('state.updated', (channels) => {
          assert.equal(channels.length, 1);
          assert.equal(channels[0].db, null);
          assert.equal(channels[0].state.loading, true);
          assert.equal(channels[0].state.syncing, 0);
          done();
        });
        orbit.join(channel);
      });

      it('emits \'ready\'', (done) => {
        const channel = 'test1';
        orbit.events.on('ready', (channelName) => {
          assert.equal(channelName, channel);
          done();
        });
        orbit.join(channel);
      });

      it('emits \'state.updated\' on ready', (done) => {
        const channel = 'test1';
        orbit.events.on('ready', () => {
          orbit.events.on('state.updated', (channels) => {
            assert.equal(channels.length, 1);
            assert.equal(channels[0].db, null);
            assert.equal(channels[0].state.loading, false);
            assert.equal(channels[0].state.syncing, 0);
            done();
          });
        });
        orbit.join(channel);
      });

      it('emits \'sync\' on load', (done) => {
        const channel = 'test1';
        orbit.events.on('sync', (channelName) => {
          assert.equal(channelName, channel);
          done();
        });
        orbit.join(channel);
      });

      it('emits \'state.updated\' on sync', (done) => {
        const channel = 'test1';
        orbit.join(channel)
          .then(() => {
            orbit.events.removeAllListeners('state.updated');
            orbit.events.on('sync', (channelName) => {
              orbit.events.on('state.updated', (channels) => {
                assert.equal(channels.length, 1);
                assert.notEqual(channels[0].db, null);
                assert.equal(channels[0].state.loading, false);
                assert.equal(channels[0].state.syncing, 1);
                done();
              });
            });
          });
      });

      it('emits \'sync\'', (done) => {
        const channel = 'test1';
        orbit.join(channel).then(() => {
          orbit.events.on('sync', (channelName) => {
            assert.equal(channelName, channel);
            done();
          });
        });
      });

      it('emits \'state.updated\' on synced', (done) => {
        const channel = 'test1';
        orbit.join(channel).then(() => {
          orbit.events.removeAllListeners('state.updated');
          orbit.events.on('synced', (channelName) => {
            orbit.events.on('state.updated', (channels) => {
              assert.equal(channels.length, 1);
              assert.notEqual(channels[0].db, null);
              assert.equal(channels[0].state.loading, false);
              assert.equal(channels[0].state.syncing, 0);
              done();
            });
          });
        });
      });

      it('emits \'synced\' after sync', (done) => {
        const channel = 'test1';
        orbit.events.on('synced', (channelName) => {
          orbit.events.removeAllListeners('synced');
          orbit.events.on('synced', (channelName, items) => {
            assert.equal(channelName, channel);
            done();
          });
          orbit.send(channel, 'hello');
        });
        orbit.join(channel);
      });
    });

  });
});
