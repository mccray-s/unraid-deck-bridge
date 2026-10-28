import fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { resolvers } from '../dist/index.js';
const app = await NestFactory.createApplicationContext(
  GraphQLSchemaBuilderModule,
  { logger: false },
);
try {
  const schema = await app.get(GraphQLSchemaFactory).create(resolvers);
  const text = printSchema(schema) + '\n';
  const destination = new URL('../contracts/schema.graphql', import.meta.url);
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(destination, 'utf8') !== text)
      throw new Error('GraphQL contract is stale; run npm run schema');
  } else fs.writeFileSync(destination, text);
} finally {
  await app.close();
}
