import Knex from 'knex';

const knexConfig = {
    client: 'mysql2',
    connection: process.env.DATABASE_URL || {
        host: 'localhost',
        user: 'cars_user',
        password: 'cars_pass',
        database: 'cars_db'
    },
    migrations: {
        directory: './src/migrations'
    }
};

const db = Knex(knexConfig);

export default db;
