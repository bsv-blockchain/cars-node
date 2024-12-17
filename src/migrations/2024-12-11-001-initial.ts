import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    // Users table
    await knex.schema.createTable('users', table => {
        table.increments('id').primary();
        table.string('identity_key', 66).unique().notNullable();
        table.string('email', 255).notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    // Projects table
    await knex.schema.createTable('projects', table => {
        table.increments('id').primary();
        table.string('project_uuid', 32).unique().notNullable(); // hex id
        table.string('name', 255).notNullable();
        table.string('private_key', 64).notNullable();
        table.string('network', 7).notNullable();
        table.decimal('balance', 20, 8).defaultTo(0);
        table.string('web_ui_config');
        table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    // Project admins
    await knex.schema.createTable('project_admins', table => {
        table.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
        table.string('identity_key', 66).notNullable();
        table.primary(['project_id', 'identity_key']);
    });

    // Deploys table
    await knex.schema.createTable('deploys', table => {
        table.increments('id').primary();
        table.string('deployment_uuid', 32).unique().notNullable(); // hex id
        table.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
        table.string('creator_identity_key', 66).notNullable();
        table.string('file_path', 1024); // path to artifact if stored locally
        table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    // Logs table
    await knex.schema.createTable('logs', table => {
        table.increments('id').primary();
        table.integer('project_id').unsigned().references('id').inTable('projects').onDelete('CASCADE').index();
        table.integer('deploy_id').unsigned().references('id').inTable('deploys').onDelete('CASCADE').index();
        table.text('message').notNullable();
        table.timestamp('timestamp').defaultTo(knex.fn.now()).index();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('logs');
    await knex.schema.dropTableIfExists('deploys');
    await knex.schema.dropTableIfExists('project_admins');
    await knex.schema.dropTableIfExists('projects');
    await knex.schema.dropTableIfExists('users');
}
