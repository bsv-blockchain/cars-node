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
        table.string('frontend_custom_domain');
        table.string('backend_custom_domain');
        table.string('engine_config');
        table.string('admin_bearer_token', 64);
    });

    // Project admins
    await knex.schema.createTable('project_admins', table => {
        table.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
        table.string('identity_key', 66).notNullable();
        table.timestamp('added_at').defaultTo(knex.fn.now());
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

    // Project accounting table - tracks credits and debits (billing)
    await knex.schema.createTable('project_accounting', table => {
        table.increments('id').primary();
        table.integer('project_id').unsigned().notNullable().references('id').inTable('projects').onDelete('CASCADE');
        table.integer('deploy_id').unsigned().references('id').inTable('deploys').onDelete('SET NULL');
        table.timestamp('timestamp').defaultTo(knex.fn.now());
        table.enum('type', ['credit', 'debit']).notNullable();
        // We'll store rates and resource breakdown as JSON for flexibility
        table.json('metadata').notNullable();
        table.decimal('amount_sats', 20, 8).notNullable();
        table.decimal('balance_after', 20, 8).notNullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('project_accounting');
    await knex.schema.dropTableIfExists('logs');
    await knex.schema.dropTableIfExists('deploys');
    await knex.schema.dropTableIfExists('project_admins');
    await knex.schema.dropTableIfExists('projects');
    await knex.schema.dropTableIfExists('users');
}
