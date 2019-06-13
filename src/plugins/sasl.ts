import { Agent } from '../';
import { Credentials, Mechanism } from '../lib/sasl';
import { SASL } from '../protocol';

declare module '../' {
    export interface Agent {
        getCredentials(): Promise<AgentConfig['credentials']>;
    }
    export interface AgentConfig {
        credentials?: Credentials;
    }
    export interface AgentEvents {
        'auth:success': Credentials | undefined;
        'auth:failed': void;
        'credentials:update': Credentials;
        sasl: SASL;
    }
}

export default function(client: Agent) {
    client.registerFeature('sasl', 100, async (features, done) => {
        const mech = client.sasl.createMechanism(features.sasl!.mechanisms);

        const saslHandler = async (sasl: SASL) => {
            if (!mech) {
                return;
            }

            switch (sasl.type) {
                case 'success': {
                    client.features.negotiated.sasl = true;
                    client.off('sasl', saslHandler);
                    client.emit('auth:success', client.config.credentials);
                    done('restart');
                    return;
                }

                case 'challenge': {
                    mech.processChallenge(sasl.value!);

                    try {
                        const credentials = (await client.getCredentials()) as Credentials;
                        const resp = mech.createResponse(credentials);
                        if (resp || resp === '') {
                            client.send('sasl', {
                                type: 'response',
                                value: resp!
                            });
                        } else {
                            client.send('sasl', {
                                type: 'response'
                            });
                        }

                        const cacheable = mech.getCacheableCredentials();
                        if (cacheable) {
                            if (!client.config.credentials) {
                                client.config.credentials = {};
                            }
                            client.config.credentials = {
                                ...client.config.credentials,
                                ...cacheable
                            };
                            client.emit('credentials:update', client.config.credentials);
                        }
                    } catch (err) {
                        console.error(err);
                        client.send('sasl', {
                            type: 'abort'
                        });
                    }
                    return;
                }

                case 'failure': {
                    client.off('sasl', saslHandler);
                    client.emit('auth:failed');
                    done('disconnect', 'authentication failed');
                    return;
                }

                case 'abort': {
                    client.off('sasl', saslHandler);
                    client.emit('auth:failed');
                    done('disconnect', 'authentication failed');
                    return;
                }
            }
        };

        if (!mech) {
            client.off('sasl', saslHandler);
            client.emit('auth:failed');
            return done('disconnect', 'authentication failed');
        }

        client.on('sasl', saslHandler);
        client.once('disconnected', () => {
            client.features.negotiated.sasl = false;
            client.off('sasl', saslHandler);
        });

        try {
            const credentials = (await client.getCredentials()) as Credentials;
            client.send('sasl', {
                mechanism: mech.name,
                type: 'auth',
                value: mech.createResponse(credentials)!
            });
        } catch (err) {
            console.error(err);
            client.send('sasl', {
                type: 'abort'
            });
        }
    });
}
