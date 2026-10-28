import { Field, Float, InputType, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsArray,
  IsObject,
  ValidateNested,
} from 'class-validator';
// Mirrors the versioned runtime schemas in contracts/openapi.json.
@InputType()
export class DeckBridgeHealthcheckInput {
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  test?: string[];
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  interval?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  timeout?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  startPeriod?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  startInterval?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  retries?: number;
}
@ObjectType()
export class DeckBridgeHealthcheck {
  @Field(() => [String], { nullable: true }) test?: string[];
  @Field(() => Float, { nullable: true }) interval?: number;
  @Field(() => Float, { nullable: true }) timeout?: number;
  @Field(() => Float, { nullable: true }) startPeriod?: number;
  @Field(() => Float, { nullable: true }) startInterval?: number;
  @Field(() => Float, { nullable: true }) retries?: number;
}
@InputType()
export class DeckBridgeNetworkAttachmentInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  name?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  ipv4?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  ipv6?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  macAddress?: string;
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}
@ObjectType()
export class DeckBridgeNetworkAttachment {
  @Field(() => String, { nullable: true }) name?: string;
  @Field(() => String, { nullable: true }) ipv4?: string;
  @Field(() => String, { nullable: true }) ipv6?: string;
  @Field(() => String, { nullable: true }) macAddress?: string;
  @Field(() => [String], { nullable: true }) aliases?: string[];
}
@InputType()
export class DeckBridgeRuntimeInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  user?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  workingDir?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  hostname?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  domainname?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  stopSignal?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  restartPolicy?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  logDriver?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  cpuSet?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  cpuSetMems?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  runtime?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  pidMode?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  ipcMode?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  utsMode?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  usernsMode?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  cgroupnsMode?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  cgroupParent?: string;
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  entrypoint?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cmd?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  groupAdd?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capAdd?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capDrop?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  securityOpt?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dns?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dnsSearch?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dnsOptions?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraHosts?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  devices?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  gpus?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ulimits?: string[];
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deviceCgroupRules?: string[];
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  stopTimeout?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  restartRetries?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  memory?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  memorySwap?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  memoryReservation?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  memorySwappiness?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  nanoCpus?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  cpuShares?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  cpuQuota?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  cpuPeriod?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  pidsLimit?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  shmSize?: number;
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsInt()
  @Max(Number.MAX_SAFE_INTEGER)
  @Min(-Number.MAX_SAFE_INTEGER)
  oomScoreAdj?: number;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  init?: boolean;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  openStdin?: boolean;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  tty?: boolean;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  readOnlyRootfs?: boolean;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  autoRemove?: boolean;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  oomKillDisable?: boolean;
  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  logOptions?: Record<string, string>;
  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  sysctls?: Record<string, string>;
  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  storageOptions?: Record<string, string>;
  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  tmpfs?: Record<string, string>;
  @Field(() => DeckBridgeHealthcheckInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeckBridgeHealthcheckInput)
  healthcheck?: DeckBridgeHealthcheckInput;
}
@ObjectType()
export class DeckBridgeRuntime {
  @Field(() => String, { nullable: true }) user?: string;
  @Field(() => String, { nullable: true }) workingDir?: string;
  @Field(() => String, { nullable: true }) hostname?: string;
  @Field(() => String, { nullable: true }) domainname?: string;
  @Field(() => String, { nullable: true }) stopSignal?: string;
  @Field(() => String, { nullable: true }) restartPolicy?: string;
  @Field(() => String, { nullable: true }) logDriver?: string;
  @Field(() => String, { nullable: true }) cpuSet?: string;
  @Field(() => String, { nullable: true }) cpuSetMems?: string;
  @Field(() => String, { nullable: true }) runtime?: string;
  @Field(() => String, { nullable: true }) pidMode?: string;
  @Field(() => String, { nullable: true }) ipcMode?: string;
  @Field(() => String, { nullable: true }) utsMode?: string;
  @Field(() => String, { nullable: true }) usernsMode?: string;
  @Field(() => String, { nullable: true }) cgroupnsMode?: string;
  @Field(() => String, { nullable: true }) cgroupParent?: string;
  @Field(() => [String], { nullable: true }) entrypoint?: string[];
  @Field(() => [String], { nullable: true }) cmd?: string[];
  @Field(() => [String], { nullable: true }) groupAdd?: string[];
  @Field(() => [String], { nullable: true }) capAdd?: string[];
  @Field(() => [String], { nullable: true }) capDrop?: string[];
  @Field(() => [String], { nullable: true }) securityOpt?: string[];
  @Field(() => [String], { nullable: true }) dns?: string[];
  @Field(() => [String], { nullable: true }) dnsSearch?: string[];
  @Field(() => [String], { nullable: true }) dnsOptions?: string[];
  @Field(() => [String], { nullable: true }) extraHosts?: string[];
  @Field(() => [String], { nullable: true }) devices?: string[];
  @Field(() => [String], { nullable: true }) gpus?: string[];
  @Field(() => [String], { nullable: true }) ulimits?: string[];
  @Field(() => [String], { nullable: true }) deviceCgroupRules?: string[];
  @Field(() => Float, { nullable: true }) stopTimeout?: number;
  @Field(() => Float, { nullable: true }) restartRetries?: number;
  @Field(() => Float, { nullable: true }) memory?: number;
  @Field(() => Float, { nullable: true }) memorySwap?: number;
  @Field(() => Float, { nullable: true }) memoryReservation?: number;
  @Field(() => Float, { nullable: true }) memorySwappiness?: number;
  @Field(() => Float, { nullable: true }) nanoCpus?: number;
  @Field(() => Float, { nullable: true }) cpuShares?: number;
  @Field(() => Float, { nullable: true }) cpuQuota?: number;
  @Field(() => Float, { nullable: true }) cpuPeriod?: number;
  @Field(() => Float, { nullable: true }) pidsLimit?: number;
  @Field(() => Float, { nullable: true }) shmSize?: number;
  @Field(() => Float, { nullable: true }) oomScoreAdj?: number;
  @Field(() => Boolean, { nullable: true }) init?: boolean;
  @Field(() => Boolean, { nullable: true }) openStdin?: boolean;
  @Field(() => Boolean, { nullable: true }) tty?: boolean;
  @Field(() => Boolean, { nullable: true }) readOnlyRootfs?: boolean;
  @Field(() => Boolean, { nullable: true }) autoRemove?: boolean;
  @Field(() => Boolean, { nullable: true }) oomKillDisable?: boolean;
  @Field(() => GraphQLJSON, { nullable: true }) logOptions?: Record<
    string,
    string
  >;
  @Field(() => GraphQLJSON, { nullable: true }) sysctls?: Record<
    string,
    string
  >;
  @Field(() => GraphQLJSON, { nullable: true }) storageOptions?: Record<
    string,
    string
  >;
  @Field(() => GraphQLJSON, { nullable: true }) tmpfs?: Record<string, string>;
  @Field(() => DeckBridgeHealthcheck, { nullable: true })
  healthcheck?: DeckBridgeHealthcheck;
}
