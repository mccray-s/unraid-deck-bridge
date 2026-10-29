import fs from 'node:fs';
import { parseReleaseVersion } from './release-version.mjs';
import { PrefixedID } from '@unraid/shared/prefixed-id-scalar.js';
import {
  DeckBridgeHealthcheckInput,
  DeckBridgeHealthcheck,
  DeckBridgeNetworkAttachmentInput,
  DeckBridgeNetworkAttachment,
  DeckBridgeRuntimeInput,
  DeckBridgeRuntime,
} from './runtime.types.js';
import 'reflect-metadata';
import { assertSupportedHost, filterCapabilities } from './check-host.js';
import { Type } from 'class-transformer';
import {
  IsInt,
  Min,
  Max,
  ValidateNested,
  IsObject,
  IsOptional,
  IsString,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  Length,
  MaxLength,
  IsIn,
  Matches,
} from 'class-validator';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Module,
  UseGuards,
  applyDecorators,
  SetMetadata,
} from '@nestjs/common';
import {
  Args,
  Context,
  Parent,
  Field,
  InputType,
  Int,
  Float,
  Mutation,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  Subscription,
  GqlExecutionContext,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { GraphQLError } from 'graphql';
import {
  AuthAction,
  Resource,
  UsePermissions,
} from '@unraid/shared/use-permissions.directive.js';
import {
  callCore,
  coreEvents,
  callUpdateCore,
  coreUpdateEvents,
  principal,
} from './core-client.js';

const bridgeVersion: string = (() => {
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      fs.readFileSync(new URL('./release.json', import.meta.url), 'utf8'),
    );
  } catch {
    throw new Error('Bridge runtime release.json is missing or invalid JSON');
  }
  const version = (metadata as { version?: unknown } | null)?.version;
  try {
    return parseReleaseVersion(version).version;
  } catch {
    throw new Error(
      'Bridge runtime release.json requires a valid date version',
    );
  }
})();

assertSupportedHost();
const dockerIdentifier = (value: string) => new PrefixedID().parseValue(value);

@ObjectType()
export class DeckBridgeNetworkInfo {
  @Field() id!: string;
  @Field() name!: string;
  @Field() driver!: string;
  @Field() ipv6!: boolean;
  @Field() internal!: boolean;
  @Field(() => [String]) subnets!: string[];
}
@ObjectType()
export class DeckBridgeDockerEnvironment {
  @Field() engineApiVersion!: string;
  @Field(() => Int) cpuCount!: number;
  @Field(() => Float) memoryTotal!: number;
  @Field() defaultRuntime!: string;
  @Field(() => [String]) runtimes!: string[];
  @Field(() => [DeckBridgeNetworkInfo]) networks!: DeckBridgeNetworkInfo[];
}
@ObjectType()
export class DeckBridgeDeviceInfo {
  @Field() path!: string;
  @Field() kind!: string;
}
@ObjectType()
export class DeckBridgeInfo {
  @Field() principalId!: string;
  @Field({ nullable: true }) engineApiVersion?: string;
  @Field(() => GraphQLJSON, { nullable: true }) compatibility?: unknown;
  @Field() version!: string;
  @Field() coreOnline!: boolean;
  @Field() compatible!: boolean;
  @Field() dockerAvailable!: boolean;
  @Field(() => [String]) capabilities!: string[];
  @Field({ nullable: true }) reason?: string;
}
@ObjectType()
export class DeckBridgeDockerMetadata {
  @Field() iconUrl!: string;
  @Field() webUi!: string;
  @Field() shell!: string;
}
export enum DeckBridgeDockerConfigurationSource {
  UNRAID_TEMPLATE = 'UNRAID_TEMPLATE',
  ENGINE_INSPECT = 'ENGINE_INSPECT',
}
registerEnumType(DeckBridgeDockerConfigurationSource, {
  name: 'DeckBridgeDockerConfigurationSource',
});
export enum DeckBridgeTemplateImportSource {
  URL = 'URL',
  XML = 'XML',
  LOCAL = 'LOCAL',
}
registerEnumType(DeckBridgeTemplateImportSource, {
  name: 'DeckBridgeTemplateImportSource',
});
export enum DeckBridgeLocalTemplateKind {
  USER = 'USER',
  DEFAULT = 'DEFAULT',
}
registerEnumType(DeckBridgeLocalTemplateKind, {
  name: 'DeckBridgeLocalTemplateKind',
});
@ObjectType()
export class DeckBridgeLocalTemplate {
  @Field() id!: string;
  @Field(() => DeckBridgeLocalTemplateKind) kind!: DeckBridgeLocalTemplateKind;
  @Field() revision!: string;
  @Field() name!: string;
  @Field({ nullable: true }) image?: string;
  @Field({ nullable: true }) iconUrl?: string;
  @Field(() => Boolean, { nullable: true }) containerExists?: boolean | null;
  @Field(() => String, { nullable: true }) containerId!: string | null;
  @Field({ nullable: true }) issueCode?: string;
}
@InputType()
export class DeckBridgeTemplateImportInput {
  @Field(() => DeckBridgeTemplateImportSource)
  @IsIn(Object.values(DeckBridgeTemplateImportSource))
  source!: DeckBridgeTemplateImportSource;
  @Field(() => String, { nullable: true }) @IsOptional() @IsString() url?:
    | string
    | null;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1048576)
  xml?: string | null;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  templateId?: string | null;
  @Field(() => String, { nullable: true }) @IsOptional() @IsString() revision?:
    | string
    | null;
}
function templateImportInput(
  input: DeckBridgeTemplateImportInput,
): DeckBridgeTemplateImportInput {
  const required: Record<DeckBridgeTemplateImportSource, string[]> = {
    URL: ['url'],
    XML: ['xml'],
    LOCAL: ['templateId', 'revision'],
  };
  const fields = required[input.source];
  if (
    !fields ||
    ['url', 'xml', 'templateId', 'revision'].some((key) => {
      const value = input[key as keyof DeckBridgeTemplateImportInput];
      return fields.includes(key)
        ? typeof value !== 'string' || !value.trim()
        : value != null && value !== '';
    })
  )
    throw new GraphQLError('Template import source and fields must match', {
      extensions: { code: 'INVALID_INPUT' },
    });
  return input;
}
@ObjectType()
export class DeckBridgeDockerEditLimitation {
  @Field() code!: string;
  @Field({ nullable: true }) field?: string;
  @Field() blocking!: boolean;
}
@ObjectType()
export class DeckBridgeDockerEditability {
  @Field() editable!: boolean;
  @Field(() => DeckBridgeDockerConfigurationSource, { nullable: true })
  source?: DeckBridgeDockerConfigurationSource;
  @Field({ nullable: true }) reasonCode?: string;
  @Field(() => [DeckBridgeDockerEditLimitation])
  limitations!: DeckBridgeDockerEditLimitation[];
}
@ObjectType()
export class DeckBridgeConfigurationIssue {
  @Field() field!: string;
  @Field({ nullable: true }) target?: string;
  @Field(() => Int, { nullable: true }) index?: number;
}
export enum DeckBridgeConfigurationChangeKind {
  ADDED = 'ADDED',
  MODIFIED = 'MODIFIED',
  REMOVED = 'REMOVED',
  CHANGED = 'CHANGED',
}
registerEnumType(DeckBridgeConfigurationChangeKind, {
  name: 'DeckBridgeConfigurationChangeKind',
});
@ObjectType()
export class DeckBridgeConfigurationChange {
  @Field() field!: string;
  @Field(() => DeckBridgeConfigurationChangeKind)
  kind!: DeckBridgeConfigurationChangeKind;
  @Field({ nullable: true }) target?: string;
  @Field({ nullable: true }) before?: string;
  @Field({ nullable: true }) after?: string;
  @Field() sensitive!: boolean;
}
@ObjectType()
export class DeckBridgePlan {
  @Field(() => [DeckBridgeConfigurationChange])
  changeSummary!: DeckBridgeConfigurationChange[];
  @Field(() => DeckBridgeDockerConfigurationSource)
  source!: DeckBridgeDockerConfigurationSource;
  @Field(() => DeckBridgeDockerConfigurationSource)
  sourceAfter!: DeckBridgeDockerConfigurationSource;
  @Field(() => String, { nullable: true }) targetContainerId!: string | null;
  @Field(() => [DeckBridgeDockerEditLimitation])
  limitations!: DeckBridgeDockerEditLimitation[];
  @Field(() => DeckBridgeDockerMetadata) metadata!: DeckBridgeDockerMetadata;
  @Field() updateImage!: boolean;
  @Field() templateReuse!: boolean;
  @Field(() => [String]) directoriesToCreate!: string[];
  @Field() id!: string;
  @Field() kind!: string;
  @Field() expires!: string;
  @Field(() => GraphQLJSON) config!: unknown;
  @Field(() => [String]) changed!: string[];
  @Field(() => [String]) warnings!: string[];
}
@ObjectType()
export class DeckBridgeEvent {
  @Field(() => Int) sequence!: number;
  @Field() time!: string;
  @Field() stage!: string;
  @Field(() => String, { nullable: true }) code?: string;
  @Field() message!: string;
}
@ObjectType()
export class DeckBridgeError {
  @Field() code!: string;
  @Field() message!: string;
  @Field(() => DeckBridgeConfigurationIssue, { nullable: true })
  issue?: DeckBridgeConfigurationIssue;
}
@ObjectType()
export class DeckBridgeRecoveryVolume {
  @Field() name!: string;
  @Field() target!: string;
  @Field() created!: boolean;
  @Field({ nullable: true }) exists?: boolean;
  @Field({ nullable: true }) owned?: boolean;
}
@ObjectType()
export class DeckBridgeRecovery {
  @Field(() => [DeckBridgeRecoveryVolume], { nullable: true })
  volumes?: DeckBridgeRecoveryVolume[];
  @Field() checkedAt!: string;
  @Field() reason!: string;
  @Field({ nullable: true }) oldExists?: boolean;
  @Field({ nullable: true }) oldRunning?: boolean;
  @Field({ nullable: true }) replacementExists?: boolean;
  @Field({ nullable: true }) replacementRunning?: boolean;
  @Field({ nullable: true }) templateMatches?: boolean;
  @Field({ nullable: true }) autoStartMatches?: boolean;
  @Field({ nullable: true }) engineConfigurationMatches?: boolean;
}
@ObjectType()
export class DeckBridgePullLayerProgress {
  @Field() id!: string;
  @Field() phase!: string;
  @Field(() => Float, { nullable: true }) current?: number;
  @Field(() => Float, { nullable: true }) total?: number;
}
@ObjectType()
export class DeckBridgePullProgress {
  @Field(() => Int) revision!: number;
  @Field() finished!: boolean;
  @Field(() => [DeckBridgePullLayerProgress])
  layers!: DeckBridgePullLayerProgress[];
}
export enum DeckBridgeImageUpdateResult {
  IMAGE_UPDATED = 'IMAGE_UPDATED',
  IMAGE_UNCHANGED = 'IMAGE_UNCHANGED',
}
registerEnumType(DeckBridgeImageUpdateResult, {
  name: 'DeckBridgeImageUpdateResult',
});
export enum DeckBridgeConfigurationResult {
  NOT_APPLIED = 'NOT_APPLIED',
  APPLIED = 'APPLIED',
  UNKNOWN = 'UNKNOWN',
}
registerEnumType(DeckBridgeConfigurationResult, {
  name: 'DeckBridgeConfigurationResult',
});
export enum DeckBridgeStartResult {
  NOT_REQUESTED = 'NOT_REQUESTED',
  ACCEPTED = 'ACCEPTED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}
registerEnumType(DeckBridgeStartResult, { name: 'DeckBridgeStartResult' });
@ObjectType()
export class DeckBridgeOperation {
  @Field() domain!: string;
  @Field() imageUpdate!: boolean;
  @Field() canCancel!: boolean;
  @Field() cancelRequested!: boolean;
  @Field(() => DeckBridgeImageUpdateResult, { nullable: true })
  imageUpdateResult?: DeckBridgeImageUpdateResult;
  @Field(() => DeckBridgeConfigurationResult, {
    nullable: true,
    description:
      'Configuration outcome for non-image-update Docker INSTALL, EDIT, ENGINE_EDIT, TEMPLATE_ADOPT and TEMPLATE_REPLACE. UNKNOWN must be explicit; a missing outcome remains null. Null for other operations.',
  })
  configurationResult?: DeckBridgeConfigurationResult;
  @Field(() => DeckBridgeStartResult, {
    nullable: true,
    description:
      'Startup outcome for ordinary Docker configuration operations. ACCEPTED means Start was accepted, not application readiness. UNKNOWN must be explicit; a missing outcome remains null. Null for other operations.',
  })
  startResult?: DeckBridgeStartResult;
  @Field({ nullable: true }) bootId?: string;
  @Field() id!: string;
  @Field() kind!: string;
  @Field() status!: string;
  @Field() stage!: string;
  @Field() created!: string;
  @Field() updated!: string;
  @Field() name!: string;
  @Field({ nullable: true }) containerId?: string;
  @Field({ nullable: true }) oldId?: string;
  @Field(() => DeckBridgeError, { nullable: true }) error?: DeckBridgeError;
  @Field(() => [DeckBridgeEvent]) events!: DeckBridgeEvent[];
  @Field(() => DeckBridgeRecovery, { nullable: true })
  recovery?: DeckBridgeRecovery;
  @Field(() => DeckBridgePullProgress, { nullable: true })
  pullProgress?: DeckBridgePullProgress;
}
@ObjectType()
export class DeckBridgeDockerUpdateAccess {
  @Field() principalId!: string;
  @Field() coreOnline!: boolean;
  @Field() dockerAvailable!: boolean;
  @Field(() => [String]) capabilities!: string[];
  @Field({ nullable: true }) reason?: string;
}
export enum DeckBridgeUpdateCheckStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  INTERRUPTED = 'INTERRUPTED',
}
registerEnumType(DeckBridgeUpdateCheckStatus, {
  name: 'DeckBridgeUpdateCheckStatus',
});
export enum DeckBridgeUpdateCheckItemState {
  PENDING = 'PENDING',
  CHECKING = 'CHECKING',
  COMPLETED = 'COMPLETED',
  SKIPPED = 'SKIPPED',
  FAILED = 'FAILED',
}
registerEnumType(DeckBridgeUpdateCheckItemState, {
  name: 'DeckBridgeUpdateCheckItemState',
});
export enum DeckBridgeImageUpdateAvailability {
  AVAILABLE = 'AVAILABLE',
  CURRENT = 'CURRENT',
  UNKNOWN = 'UNKNOWN',
  PINNED = 'PINNED',
  UNTRACKED = 'UNTRACKED',
  SKIPPED = 'SKIPPED',
}
registerEnumType(DeckBridgeImageUpdateAvailability, {
  name: 'DeckBridgeImageUpdateAvailability',
});
export enum DeckBridgeUpdateCheckEventKind {
  ITEM_CHANGED = 'ITEM_CHANGED',
  COMPLETED = 'COMPLETED',
}
registerEnumType(DeckBridgeUpdateCheckEventKind, {
  name: 'DeckBridgeUpdateCheckEventKind',
});
export enum DeckBridgeImageUpdateBatchItemStatus {
  WAITING = 'WAITING',
  RUNNING = 'RUNNING',
  UPDATED = 'UPDATED',
  UNCHANGED = 'UNCHANGED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
  NEEDS_ATTENTION = 'NEEDS_ATTENTION',
  INTERRUPTED = 'INTERRUPTED',
  CANCELLED = 'CANCELLED',
}
registerEnumType(DeckBridgeImageUpdateBatchItemStatus, {
  name: 'DeckBridgeImageUpdateBatchItemStatus',
});
export enum DeckBridgeImageUpdateBatchEventKind {
  ITEM_CHANGED = 'ITEM_CHANGED',
  ACTIVE_PROGRESS = 'ACTIVE_PROGRESS',
  COMPLETED = 'COMPLETED',
}
registerEnumType(DeckBridgeImageUpdateBatchEventKind, {
  name: 'DeckBridgeImageUpdateBatchEventKind',
});
@ObjectType()
export class DeckBridgeImagePlatform {
  @Field() os!: string;
  @Field() architecture!: string;
  @Field({ nullable: true }) variant?: string;
}
@ObjectType()
export class DeckBridgeUpdateCheckItem {
  @Field() containerId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) currentImageId?: string;
  @Field({ nullable: true }) imageReference?: string;
  @Field(() => DeckBridgeImagePlatform, { nullable: true })
  platform?: DeckBridgeImagePlatform;
  @Field(() => DeckBridgeDockerConfigurationSource, { nullable: true })
  source?: DeckBridgeDockerConfigurationSource;
  @Field(() => DeckBridgeUpdateCheckItemState)
  state!: DeckBridgeUpdateCheckItemState;
  @Field(() => DeckBridgeImageUpdateAvailability)
  availability!: DeckBridgeImageUpdateAvailability;
  @Field() canUpdate!: boolean;
  @Field({ nullable: true }) reasonCode?: string;
  @Field({ nullable: true }) checkedAt?: string;
  @Field({ nullable: true }) expiresAt?: string;
  @Field() fromCache!: boolean;
  @Field(() => Int) revision!: number;
  @Field({ nullable: true }) remoteImageId?: string;
}
@ObjectType()
export class DeckBridgeUpdateCheck {
  @Field() id!: string;
  @Field(() => DeckBridgeUpdateCheckStatus)
  status!: DeckBridgeUpdateCheckStatus;
  @Field(() => Int) revision!: number;
  @Field(() => Int) eventSequence!: number;
  @Field(() => Int) total!: number;
  @Field(() => Int) completed!: number;
  @Field(() => Int) available!: number;
  @Field(() => Int) skipped!: number;
  @Field(() => Int) failed!: number;
  @Field() created!: string;
  @Field() updated!: string;
  @Field({ nullable: true }) nextRefreshAt?: string;
  @Field(() => [DeckBridgeUpdateCheckItem]) items!: DeckBridgeUpdateCheckItem[];
  @Field(() => Int, { nullable: true }) nextOffset?: number;
  @Field(() => DeckBridgeError, { nullable: true }) error?: DeckBridgeError;
}
@ObjectType()
export class DeckBridgeUpdateCheckEvent {
  @Field(() => Int) sequence!: number;
  @Field(() => DeckBridgeUpdateCheckEventKind)
  kind!: DeckBridgeUpdateCheckEventKind;
  @Field(() => DeckBridgeUpdateCheckItem, { nullable: true })
  item?: DeckBridgeUpdateCheckItem;
  @Field(() => DeckBridgeUpdateCheckStatus)
  status!: DeckBridgeUpdateCheckStatus;
  @Field(() => Int) completed!: number;
  @Field(() => Int) total!: number;
}
@InputType()
export class DeckBridgeImageUpdateTargetInput {
  @Field() @IsString() @Length(1, 128) checkId!: string;
  @Field() @IsString() @Length(1, 512) containerId!: string;
  @Field() @IsString() @Length(1, 128) currentImageId!: string;
  @Field(() => Int) @IsInt() @Min(0) @Max(2147483647) revision!: number;
  @Field(() => Boolean, { defaultValue: false })
  @IsBoolean()
  allowMissingTemplate: boolean = false;
}
@InputType()
export class DeckBridgeImageUpdateBatchInput {
  @Field() @IsString() @Length(8, 128) requestId!: string;
  @Field(() => [DeckBridgeImageUpdateTargetInput])
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DeckBridgeImageUpdateTargetInput)
  targets!: DeckBridgeImageUpdateTargetInput[];
}
@ObjectType()
export class DeckBridgeImageUpdateBatchItem {
  @Field(() => Int) index!: number;
  @Field(() => Int) revision!: number;
  @Field() sourceContainerId!: string;
  @Field() currentImageId!: string;
  @Field({ nullable: true }) operationId?: string;
  @Field(() => DeckBridgeImageUpdateBatchItemStatus)
  status!: DeckBridgeImageUpdateBatchItemStatus;
  @Field({ nullable: true }) resultContainerId?: string;
  @Field({ nullable: true }) reasonCode?: string;
  @Field(() => DeckBridgeImageUpdateResult, { nullable: true })
  imageUpdateResult?: DeckBridgeImageUpdateResult;
}
@ObjectType()
export class DeckBridgeImageUpdateBatch {
  @Field() id!: string;
  @Field() status!: string;
  @Field(() => Int) revision!: number;
  @Field(() => Int) eventSequence!: number;
  @Field() canCancel!: boolean;
  @Field() cancelRequested!: boolean;
  @Field(() => Int) total!: number;
  @Field(() => Int) completed!: number;
  @Field(() => Int) updated!: number;
  @Field(() => Int) unchanged!: number;
  @Field(() => Int) failed!: number;
  @Field(() => Int) skipped!: number;
  @Field(() => Int) needsAttention!: number;
  @Field(() => Int) cancelled!: number;
  @Field(() => DeckBridgeOperation, { nullable: true })
  activeOperation?: DeckBridgeOperation;
  @Field(() => [DeckBridgeImageUpdateBatchItem])
  items!: DeckBridgeImageUpdateBatchItem[];
  @Field(() => Int, { nullable: true }) nextOffset?: number;
}
@ObjectType()
export class DeckBridgeImageUpdateBatchEvent {
  @Field(() => Int) sequence!: number;
  @Field(() => DeckBridgeImageUpdateBatchEventKind)
  kind!: DeckBridgeImageUpdateBatchEventKind;
  @Field(() => DeckBridgeImageUpdateBatchItem, { nullable: true })
  item?: DeckBridgeImageUpdateBatchItem;
  @Field(() => DeckBridgeOperation, { nullable: true })
  activeOperation?: DeckBridgeOperation;
  @Field() status!: string;
  @Field(() => Int) completed!: number;
  @Field(() => Int) total!: number;
  @Field() canCancel!: boolean;
  @Field() cancelRequested!: boolean;
}
function updatePage(offset: number, limit: number): string {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 2147483647 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new GraphQLError('Invalid update page', {
      extensions: { code: 'INVALID_INPUT' },
    });
  return `offset=${offset}&limit=${limit}`;
}
function updateCursor(after: number): number {
  if (!Number.isInteger(after) || after < 0 || after > 2147483647)
    throw new GraphQLError('Invalid event cursor', {
      extensions: { code: 'INVALID_INPUT' },
    });
  return after;
}
function updateRequestID(requestId: string): string {
  if (
    typeof requestId !== 'string' ||
    requestId.length < 8 ||
    requestId.length > 128
  )
    throw new GraphQLError('Invalid request ID', {
      extensions: { code: 'INVALID_INPUT' },
    });
  return requestId;
}
function imageUpdateTarget(
  input: DeckBridgeImageUpdateTargetInput,
): DeckBridgeImageUpdateTargetInput {
  if (
    typeof input.checkId !== 'string' ||
    !input.checkId ||
    typeof input.currentImageId !== 'string' ||
    !input.currentImageId ||
    !Number.isInteger(input.revision) ||
    input.revision < 0 ||
    input.revision > 2147483647
  )
    throw new GraphQLError('Invalid image-update target', {
      extensions: { code: 'INVALID_INPUT' },
    });
  if (
    input.allowMissingTemplate !== undefined &&
    typeof input.allowMissingTemplate !== 'boolean'
  )
    throw new GraphQLError('Invalid missing-template confirmation', {
      extensions: { code: 'INVALID_INPUT' },
    });
  return {
    checkId: input.checkId,
    containerId: dockerIdentifier(input.containerId),
    currentImageId: input.currentImageId,
    revision: input.revision,
    allowMissingTemplate: input.allowMissingTemplate ?? false,
  };
}
@ObjectType()
export class DeckBridgeDraftField {
  @Field() id!: string;
  @Field() type!: string;
  @Field() name!: string;
  @Field() target!: string;
  @Field() description!: string;
  @Field() value!: string;
  @Field() mode!: string;
  @Field() required!: boolean;
  @Field() sensitive!: boolean;
  @Field() hasValue!: boolean;
  @Field() advanced!: boolean;
  @Field() defaultValue!: string;
  @Field() hasDefaultValue!: boolean;
  @Field() templateEditable!: boolean;
  @Field(() => [String]) options!: string[];
}
@ObjectType()
export class DeckBridgeTemplateDraft {
  @Field(() => DeckBridgeDockerConfigurationSource)
  source!: DeckBridgeDockerConfigurationSource;
  @Field(() => [DeckBridgeDockerEditLimitation])
  limitations!: DeckBridgeDockerEditLimitation[];
  @Field(() => DeckBridgeDockerMetadata) metadata!: DeckBridgeDockerMetadata;
  @Field(() => DeckBridgeRuntime, { nullable: true })
  runtime?: DeckBridgeRuntime;
  @Field({ nullable: true }) extraParams?: string;
  @Field({ nullable: true }) postArgs?: string;
  @Field(() => [DeckBridgeNetworkAttachment], { nullable: true })
  networks?: DeckBridgeNetworkAttachment[];
  @Field({ nullable: true }) containerId?: string;
  @Field({ nullable: true }) running?: boolean;
  @Field({ nullable: true }) autoStart?: boolean;
  @Field() privileged!: boolean;
  @Field() id!: string;
  @Field() expires!: string;
  @Field() sourceUrl!: string;
  @Field() digest!: string;
  @Field() name!: string;
  @Field() image!: string;
  @Field() network!: string;
  @Field() appDataRoot!: string;
  @Field(() => [DeckBridgeDraftField]) fields!: DeckBridgeDraftField[];
}
@ObjectType()
export class DeckBridgeCreationDefaults {
  @Field() appDataRoot!: string;
}
@InputType()
export class DeckBridgePortInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hostIp?: string;
  @Field(() => Int) @IsInt() @Min(0) @Max(65535) hostPort!: number;
  @Field(() => Int) @IsInt() @Min(1) @Max(65535) containerPort!: number;
  @Field() @IsString() @MaxLength(4) protocol!: string;
}
@InputType()
export class DeckBridgeMountInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  type?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  mode?: string;
  @Field() @IsString() @MaxLength(4096) source!: string;
  @Field() @IsString() @MaxLength(4096) target!: string;
  @Field() @IsBoolean() readOnly!: boolean;
}
@InputType()
export class DeckBridgeCustomValueInput {
  @Field() @IsString() @MaxLength(512) name!: string;
  @Field() @IsString() @MaxLength(65536) value!: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keepFieldId?: string;
  @Field() @IsBoolean() sensitive!: boolean;
}
@InputType()
export class DeckBridgeTemplateFieldInput {
  @Field()
  @IsString()
  @IsIn(['port', 'path', 'variable', 'label', 'device'])
  type!: string;
  @Field(() => Int) @IsInt() @Min(0) index!: number;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[^\0]*$/u)
  draftFieldId?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^[^\0]*$/u)
  displayName?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  @Matches(/^[^\0]*$/u)
  defaultValue?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  @Matches(/^[^\0]*$/u)
  description?: string;
}
@InputType()
export class DeckBridgeDockerMetadataInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  iconUrl?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  webUi?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @IsIn(['', 'sh', 'bash'])
  shell?: string;
}
@InputType()
export class DeckBridgeDockerConfigurationInput {
  @Field(() => DeckBridgeDockerMetadataInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeckBridgeDockerMetadataInput)
  metadata?: DeckBridgeDockerMetadataInput;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  draftId?: string;
  @Field() @IsString() @MaxLength(80) name!: string;
  @Field() @IsString() @MaxLength(1024) image!: string;
  @Field() @IsString() @MaxLength(256) network!: string;
  @Field() @IsBoolean() privileged!: boolean;
  @Field() @IsBoolean() start!: boolean;
  @Field() @IsBoolean() autoStart!: boolean;
  @Field(() => [DeckBridgePortInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeckBridgePortInput)
  ports!: DeckBridgePortInput[];
  @Field(() => [DeckBridgeMountInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeckBridgeMountInput)
  mounts!: DeckBridgeMountInput[];
  @Field(() => [DeckBridgeCustomValueInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeckBridgeCustomValueInput)
  environment!: DeckBridgeCustomValueInput[];
  @Field(() => [DeckBridgeCustomValueInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeckBridgeCustomValueInput)
  labels!: DeckBridgeCustomValueInput[];
  @Field(() => [DeckBridgeTemplateFieldInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1280)
  @ValidateNested({ each: true })
  @Type(() => DeckBridgeTemplateFieldInput)
  templateFields?: DeckBridgeTemplateFieldInput[];
  @Field(() => DeckBridgeRuntimeInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeckBridgeRuntimeInput)
  runtime?: DeckBridgeRuntimeInput;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  extraParams?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(65536)
  postArgs?: string;
  @Field(() => [DeckBridgeNetworkAttachmentInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeckBridgeNetworkAttachmentInput)
  networks?: DeckBridgeNetworkAttachmentInput[];
}
@InputType()
export class DeckBridgeSubmitInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  planId?: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  containerId?: string;
  @Field() @IsString() @Length(8, 128) requestId!: string;
}
function requireTemplateManagement(core: any): void {
  if (
    !Array.isArray(core.capabilities) ||
    !core.capabilities.includes('docker.templateManagementRead')
  )
    throw new GraphQLError(
      'Update the Bridge deployment to manage Docker templates',
      { extensions: { code: 'TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED' } },
    );
}
function requireTemplateFieldsRead(core: any): void {
  if (
    !Array.isArray(core.capabilities) ||
    !core.capabilities.includes('docker.templateFieldsRead')
  )
    throw new GraphQLError(
      'Update the Bridge deployment to read Docker template fields',
      { extensions: { code: 'TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED' } },
    );
}
@Injectable()
export class DeckBridgeService {
  async info(context: any): Promise<DeckBridgeInfo> {
    const actor = principal(context);
    const compatibility = assertSupportedHost();
    try {
      const core = await callCore(actor, '/info');
      const compatible = core.version === bridgeVersion;
      return {
        principalId: actor,
        compatibility,
        engineApiVersion: core.engineApiVersion,
        version: bridgeVersion,
        coreOnline: true,
        compatible,
        dockerAvailable: core.dockerAvailable,
        capabilities: compatible
          ? filterCapabilities(compatibility, core.capabilities)
          : [],
        reason: !compatible
          ? 'CORE_VERSION_MISMATCH'
          : !core.accepting
            ? 'CORE_DRAINING'
            : !core.dockerAvailable
              ? 'DOCKER_UNAVAILABLE'
              : undefined,
      };
    } catch {
      return {
        principalId: actor,
        compatibility,
        version: bridgeVersion,
        coreOnline: false,
        compatible: false,
        dockerAvailable: false,
        capabilities: [],
        reason: 'CORE_UNAVAILABLE',
      };
    }
  }
  async updateAccess(context: any): Promise<DeckBridgeDockerUpdateAccess> {
    const actor = principal(context),
      host = assertSupportedHost();
    try {
      const access = await callUpdateCore(actor, '/docker/update-access');
      if (
        !access ||
        typeof access.coreOnline !== 'boolean' ||
        typeof access.dockerAvailable !== 'boolean' ||
        !Array.isArray(access.capabilities) ||
        access.capabilities.some((value: unknown) => typeof value !== 'string')
      )
        throw new GraphQLError('Core returned an invalid access response', {
          extensions: { code: 'CORE_RESPONSE_INVALID' },
        });
      return {
        principalId: actor,
        coreOnline: access.coreOnline,
        dockerAvailable: access.dockerAvailable,
        capabilities: filterCapabilities(host, access.capabilities),
        reason:
          typeof access.reason === 'string' &&
          /^[A-Z][A-Z0-9_]{1,63}$/.test(access.reason)
            ? access.reason
            : undefined,
      };
    } catch (error) {
      if (
        !(error instanceof GraphQLError) ||
        error.extensions.code !== 'CORE_UNAVAILABLE'
      )
        throw error;
      return {
        principalId: actor,
        coreOnline: false,
        dockerAvailable: false,
        capabilities: [],
        reason: 'CORE_UNAVAILABLE',
      };
    }
  }
  async templateFieldsRead(context: any, path: string) {
    const actor = principal(context);
    requireTemplateFieldsRead(await callCore(actor, '/info'));
    return callCore(actor, path);
  }
  async templateManagementRead(context: any, path: string) {
    const actor = principal(context);
    requireTemplateManagement(await callCore(actor, '/info'));
    return callCore(actor, path);
  }
  async write(context: any, path: string, input: unknown, safeUpdate = false) {
    const host = assertSupportedHost();
    if (
      host?.hostWriteSupported === false ||
      (host?.dockerWriteSupported === false && !path.endsWith('/restart'))
    )
      throw new GraphQLError(
        'Docker Manager implementation is outside the audited profile',
        { extensions: { code: 'DOCKER_COMPATIBILITY_UNVERIFIED' } },
      );
    const actor = principal(context);
    const core = await (safeUpdate
      ? callUpdateCore(actor, '/info')
      : callCore(actor, '/info'));
    if (core.version !== bridgeVersion)
      throw new GraphQLError('Bridge deployment components do not match', {
        extensions: { code: 'CORE_VERSION_MISMATCH' },
      });
    if (
      path === '/docker/preview' ||
      path === '/docker/preview/template-replacement' ||
      path === '/docker/image-updates/preview'
    )
      requireTemplateManagement(core);
    if (path === '/docker/drafts') requireTemplateFieldsRead(core);
    const fields = (
      input as { config?: DeckBridgeDockerConfigurationInput } | null
    )?.config?.templateFields;
    if (
      (path === '/docker/preview' ||
        path === '/docker/preview/template-replacement') &&
      fields?.length
    ) {
      requireTemplateFieldsRead(core);
      if (
        !Array.isArray(core.capabilities) ||
        !core.capabilities.includes('docker.templateFields')
      )
        throw new GraphQLError(
          'Update the Bridge deployment to write Docker template fields',
          { extensions: { code: 'TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED' } },
        );
    }
    if (!core.accepting || !core.dockerAvailable)
      throw new GraphQLError('Docker operations are currently unavailable', {
        extensions: { code: 'DOCKER_UNAVAILABLE' },
      });
    return safeUpdate
      ? callUpdateCore(actor, path, input)
      : callCore(actor, path, input);
  }
  async cancel(context: any, operationId: string, action: 'install' | 'edit') {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId))
      throw new GraphQLError('Invalid operation ID', {
        extensions: { code: 'INVALID_INPUT' },
      });
    const actor = principal(context),
      host = assertSupportedHost();
    if (
      host?.hostWriteSupported === false ||
      host?.dockerWriteSupported === false
    )
      throw new GraphQLError(
        'Docker Manager implementation is outside the audited profile',
        { extensions: { code: 'DOCKER_COMPATIBILITY_UNVERIFIED' } },
      );
    // Cancellation must not wait for the availability preflight.
    const input = { operationId, coreVersion: bridgeVersion },
      path = `/docker/cancel/${action}`;
    return action === 'edit'
      ? callUpdateCore(actor, path, input)
      : callCore(actor, path, input);
  }
}

// Namespace access requires authentication; child fields enforce resource permissions.
@Injectable()
export class DeckBridgeNamespaceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    principal(GqlExecutionContext.create(context).getContext());
    return true;
  }
}
export function AuthenticatedNamespace() {
  return applyDecorators(
    SetMetadata('isAuthenticatedEndpoint', true),
    UseGuards(DeckBridgeNamespaceGuard),
  );
}

// Results are scoped to operation kind; parent fields enforce resource permissions.
@Resolver(() => DeckBridgeOperation)
export class DeckBridgeOperationResolver {
  @ResolveField(() => Boolean)
  @AuthenticatedNamespace()
  canCancel(@Parent() operation: DeckBridgeOperation) {
    return operation.canCancel;
  }
  @ResolveField(() => Boolean)
  @AuthenticatedNamespace()
  cancelRequested(@Parent() operation: DeckBridgeOperation) {
    return operation.cancelRequested;
  }
  @ResolveField(() => Boolean)
  @AuthenticatedNamespace()
  imageUpdate(@Parent() operation: DeckBridgeOperation) {
    return operation.domain === 'docker' && operation.imageUpdate === true;
  }
  @ResolveField(() => DeckBridgeImageUpdateResult, { nullable: true })
  @AuthenticatedNamespace()
  imageUpdateResult(@Parent() operation: DeckBridgeOperation) {
    return this.imageUpdate(operation)
      ? operation.imageUpdateResult || null
      : null;
  }
  @ResolveField(() => DeckBridgeConfigurationResult, { nullable: true })
  @AuthenticatedNamespace()
  configurationResult(@Parent() operation: DeckBridgeOperation) {
    return this.configurationOperation(operation)
      ? operation.configurationResult
      : null;
  }
  @ResolveField(() => DeckBridgeStartResult, { nullable: true })
  @AuthenticatedNamespace()
  startResult(@Parent() operation: DeckBridgeOperation) {
    return this.configurationOperation(operation)
      ? operation.startResult
      : null;
  }
  private configurationOperation(operation: DeckBridgeOperation): boolean {
    if (operation.domain !== 'docker' || operation.imageUpdate === true)
      return false;
    switch (operation.kind) {
      case 'INSTALL':
      case 'EDIT':
      case 'ENGINE_EDIT':
      case 'TEMPLATE_ADOPT':
      case 'TEMPLATE_REPLACE':
        return true;
      default:
        return false;
    }
  }
}

@ObjectType()
export class DeckBridgeQueries {}
@ObjectType()
export class DeckBridgeMutations {}
@ObjectType()
export class DeckBridgeDockerQueries {}
@ObjectType()
export class DeckBridgeDockerMutations {}
@ObjectType()
export class DeckBridgeOperationsQueries {}

@Resolver()
export class DeckBridgeRootResolver {
  @Query(() => DeckBridgeQueries, { name: 'deckBridge' })
  @AuthenticatedNamespace()
  query() {
    return {};
  }
  @Mutation(() => DeckBridgeMutations, { name: 'deckBridge' })
  @AuthenticatedNamespace()
  mutation() {
    return {};
  }
}
@Resolver(() => DeckBridgeQueries)
export class DeckBridgeQueriesResolver {
  @ResolveField(() => DeckBridgeSystemQueries)
  @AuthenticatedNamespace()
  system() {
    return {};
  }

  @ResolveField(() => DeckBridgePluginQueries)
  @AuthenticatedNamespace()
  plugins() {
    return {};
  }

  @ResolveField(() => DeckBridgeArrayQueries)
  @AuthenticatedNamespace()
  array() {
    return {};
  }

  constructor(private readonly handlers: DeckBridgeService) {}
  @ResolveField(() => DeckBridgeInfo)
  @UsePermissions({ resource: Resource.ME, action: AuthAction.READ_ANY })
  info(@Context() context: any) {
    return this.handlers.info(context);
  }
  @ResolveField(() => DeckBridgeDockerQueries)
  @AuthenticatedNamespace()
  docker() {
    return {};
  }
  @ResolveField(() => DeckBridgeOperationsQueries)
  @AuthenticatedNamespace()
  operations() {
    return {};
  }
}
@Resolver(() => DeckBridgeMutations)
export class DeckBridgeMutationsResolver {
  @ResolveField(() => DeckBridgeSystemMutations)
  @AuthenticatedNamespace()
  system() {
    return {};
  }

  @ResolveField(() => DeckBridgePluginMutations)
  @AuthenticatedNamespace()
  plugins() {
    return {};
  }

  @ResolveField(() => DeckBridgeArrayMutations)
  @AuthenticatedNamespace()
  array() {
    return {};
  }

  @ResolveField(() => DeckBridgeDockerMutations)
  @AuthenticatedNamespace()
  docker() {
    return {};
  }
}
@Resolver(() => DeckBridgeDockerQueries)
export class DeckBridgeDockerQueriesResolver {
  constructor(private readonly handlers: DeckBridgeService) {}
  @ResolveField(() => [DeckBridgeLocalTemplate])
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  localTemplates(@Context() context: any) {
    return this.handlers.templateManagementRead(context, '/docker/templates');
  }
  @ResolveField(() => DeckBridgeDockerUpdateAccess)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  updateAccess(@Context() context: any) {
    return this.handlers.updateAccess(context);
  }
  @ResolveField(() => DeckBridgeUpdateCheck, { nullable: true })
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  updateCheck(
    @Args('id', { type: () => String, nullable: true }) id: string | undefined,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset: number,
    @Args('limit', { type: () => Int, defaultValue: 100 }) limit: number,
    @Context() context: any,
  ) {
    return callUpdateCore(
      principal(context),
      `/docker/update-checks?${id == null ? '' : `id=${encodeURIComponent(id)}&`}${updatePage(offset, limit)}`,
    );
  }
  @ResolveField(() => DeckBridgeDockerEditability)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  editability(
    @Args('containerId') containerId: string,
    @Context() context: any,
  ) {
    return callCore(
      principal(context),
      '/docker/editability?containerId=' +
        encodeURIComponent(dockerIdentifier(containerId)),
    );
  }
  @ResolveField(() => DeckBridgeDockerEditability)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  templateAdoption(
    @Args('containerId') containerId: string,
    @Context() context: any,
  ) {
    return this.handlers.templateManagementRead(
      context,
      '/docker/template-adoption?containerId=' +
        encodeURIComponent(dockerIdentifier(containerId)),
    );
  }
  @ResolveField(() => DeckBridgeDockerEnvironment)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  environment(@Context() context: any) {
    return callCore(principal(context), '/docker/environment');
  }
  @ResolveField(() => [DeckBridgeDeviceInfo])
  @UsePermissions({ resource: Resource.OS, action: AuthAction.READ_ANY })
  devices(@Context() context: any) {
    return callCore(principal(context), '/docker/devices');
  }
  @ResolveField(() => DeckBridgeTemplateDraft)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  config(@Args('containerId') containerId: string, @Context() context: any) {
    return this.handlers.templateFieldsRead(
      context,
      '/docker/config?containerId=' +
        encodeURIComponent(dockerIdentifier(containerId)),
    );
  }
  @ResolveField(() => DeckBridgeCreationDefaults)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  creationDefaults(@Context() context: any) {
    return callCore(principal(context), '/docker/creation-defaults');
  }
}
@Resolver(() => DeckBridgeDockerMutations)
export class DeckBridgeDockerMutationsResolver {
  constructor(private readonly handlers: DeckBridgeService) {}
  @ResolveField(() => DeckBridgeUpdateCheck)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  checkUpdates(
    @Args('requestId') requestId: string,
    @Args('force', { defaultValue: false }) force: boolean,
    @Context() context: any,
  ) {
    return callUpdateCore(principal(context), '/docker/update-checks', {
      requestId: updateRequestID(requestId),
      force,
    });
  }
  @ResolveField(() => DeckBridgePlan)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  prepareImageUpdate(
    @Args('input') input: DeckBridgeImageUpdateTargetInput,
    @Context() context: any,
  ) {
    return this.handlers.write(
      context,
      '/docker/image-updates/preview',
      imageUpdateTarget(input),
      true,
    );
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  updateContainers(
    @Args('input') input: DeckBridgeImageUpdateBatchInput,
    @Context() context: any,
  ) {
    const targets = input.targets.map(imageUpdateTarget);
    if (
      !targets.length ||
      new Set(targets.map((target) => target.containerId)).size !==
        targets.length
    )
      throw new GraphQLError('Update targets must be nonempty and unique', {
        extensions: { code: 'INVALID_INPUT' },
      });
    return this.handlers.write(
      context,
      '/docker/image-update-batches',
      { requestId: updateRequestID(input.requestId), targets },
      true,
    );
  }
  @ResolveField(() => DeckBridgeTemplateDraft)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.CREATE_ANY })
  importTemplate(
    @Args('input') input: DeckBridgeTemplateImportInput,
    @Context() context: any,
  ) {
    return this.handlers.write(
      context,
      '/docker/drafts',
      templateImportInput(input),
    );
  }
  @ResolveField(() => DeckBridgePlan)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.CREATE_ANY })
  prepareInstall(
    @Args('input') input: DeckBridgeDockerConfigurationInput,
    @Context() context: any,
  ) {
    return this.handlers.write(context, '/docker/preview', {
      config: input,
      updateImage: false,
      adoptTemplate: false,
    });
  }
  @ResolveField(() => DeckBridgePlan)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  prepareEdit(
    @Args('containerId') containerId: string,
    @Args('input') input: DeckBridgeDockerConfigurationInput,
    @Args('updateImage', { defaultValue: false }) updateImage: boolean,
    @Args('adoptTemplate', { defaultValue: false }) adoptTemplate: boolean,
    @Context() context: any,
  ) {
    return this.handlers.write(context, '/docker/preview', {
      containerId: dockerIdentifier(containerId),
      config: input,
      updateImage,
      adoptTemplate,
    });
  }
  @ResolveField(() => DeckBridgePlan)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  prepareTemplateReplacement(
    @Args('containerId') containerId: string,
    @Args('input') input: DeckBridgeDockerConfigurationInput,
    @Context() context: any,
  ) {
    return this.handlers.write(
      context,
      '/docker/preview/template-replacement',
      {
        containerId: dockerIdentifier(containerId),
        config: input,
        updateImage: false,
        adoptTemplate: false,
      },
    );
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.CREATE_ANY })
  install(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return this.handlers.write(context, '/docker/submit/install', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  edit(@Args('input') input: DeckBridgeSubmitInput, @Context() context: any) {
    return this.handlers.write(context, '/docker/submit/edit', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.CREATE_ANY })
  cancelInstall(
    @Args('operationId') operationId: string,
    @Context() context: any,
  ) {
    return this.handlers.cancel(context, operationId, 'install');
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  cancelEdit(
    @Args('operationId') operationId: string,
    @Context() context: any,
  ) {
    return this.handlers.cancel(context, operationId, 'edit');
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.UPDATE_ANY })
  restart(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return this.handlers.write(context, '/docker/submit/restart', {
      ...input,
      containerId: dockerIdentifier(input.containerId ?? ''),
    });
  }
}
@Resolver(() => DeckBridgeOperationsQueries)
export class DeckBridgeOperationsResolver {
  @ResolveField(() => DeckBridgeArrayOperations)
  @AuthenticatedNamespace()
  array() {
    return {};
  }

  @ResolveField(() => DeckBridgePluginOperations)
  @AuthenticatedNamespace()
  plugins() {
    return {};
  }

  @ResolveField(() => DeckBridgeSystemOperations)
  @AuthenticatedNamespace()
  system() {
    return {};
  }

  @ResolveField(() => DeckBridgeDockerOperations)
  @AuthenticatedNamespace()
  docker() {
    return {};
  }
}

@ObjectType()
export class DeckBridgeSystemQueries {}
@ObjectType()
export class DeckBridgeSystemMutations {}
@ObjectType()
export class DeckBridgePluginQueries {}
@ObjectType()
export class DeckBridgePluginMutations {}
@ObjectType()
export class DeckBridgeArrayQueries {}
@ObjectType()
export class DeckBridgeArrayMutations {}
@ObjectType()
export class DeckBridgeSystemStatus {
  @Field() bootId!: string;
  @Field() shutdownTimeout!: string;
  @Field() powerMode!: string;
  @Field() liveExecutionVerified!: boolean;
}
@ObjectType()
export class DeckBridgeParityLastResult {
  @Field() state!: string;
  @Field(() => String, { nullable: true }) startedAt!: string | null;
  @Field(() => String, { nullable: true }) finishedAt!: string | null;
  @Field(() => String, { nullable: true }) elapsedSeconds!: string | null;
  @Field(() => String, { nullable: true }) errorCount!: string | null;
}
@ObjectType()
export class DeckBridgeParityStatus {
  @Field(() => DeckBridgeParityLastResult, { nullable: true })
  lastResult!: DeckBridgeParityLastResult | null;
  @Field() state!: string;
  @Field() kind!: string;
  @Field(() => Boolean, { nullable: true }) correcting!: boolean | null;
  @Field(() => String, { nullable: true }) positionBytes!: string | null;
  @Field(() => String, { nullable: true }) totalBytes!: string | null;
  @Field(() => String, { nullable: true }) speedBytesPerSecond!: string | null;
  @Field(() => String, {
    nullable: true,
    description:
      'Current host-reported parity duration seconds using official API semantics, or null when evidence is unknown or invalid. Resume may reset the start, so this may describe only the latest run segment, not the whole operation or all pauses; independent of lastResult.',
  })
  elapsedSeconds!: string | null;
  @Field(() => String, { nullable: true }) errorCount!: string | null;
  @Field() canStart!: boolean;
  @Field() canPause!: boolean;
  @Field() canResume!: boolean;
  @Field() canCancel!: boolean;
  @Field({ nullable: true }) reason?: string;
}
@ObjectType()
export class DeckBridgeArrayStatus {
  @Field() bootId!: string;
  @Field() observedAt!: string;
  @Field(() => DeckBridgeParityStatus) parity!: DeckBridgeParityStatus;
  @Field() state!: string;
  @Field() mdState!: string;
  @Field() fsState!: string;
  @Field() progress!: string;
  @Field() canStart!: boolean;
  @Field() canStop!: boolean;
  @Field() liveExecutionVerified!: boolean;
  @Field({ nullable: true }) reason?: string;
}
@ObjectType()
export class DeckBridgePlugin {
  @Field() id!: string;
  @Field() name!: string;
  @Field() version!: string;
  @Field() uninstallable!: boolean;
  @Field({ nullable: true }) reason?: string;
}
@ObjectType()
export class DeckBridgeHostPlan {
  @Field() id!: string;
  @Field() expires!: string;
  @Field() domain!: string;
  @Field() action!: string;
  @Field() target!: string;
  @Field() bootId!: string;
  @Field() summary!: string;
  @Field(() => Boolean, { nullable: true }) correct!: boolean | null;
  @Field(() => [String]) warnings!: string[];
}
// Action support is validated by the service.
@InputType()
export class DeckBridgeHostPreviewInput {
  @Field() @IsString() @Length(1, 16) action!: string;
}
export enum DeckBridgeParityAction {
  START = 'START',
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  CANCEL = 'CANCEL',
}
registerEnumType(DeckBridgeParityAction, { name: 'DeckBridgeParityAction' });
@InputType()
export class DeckBridgeParityPreviewInput {
  @Field(() => DeckBridgeParityAction)
  @IsIn(Object.values(DeckBridgeParityAction))
  action!: DeckBridgeParityAction;
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  correct?: boolean | null;
}
// Preserve false; reject null and correct on actions other than START.
export function parityPreview(input: DeckBridgeParityPreviewInput) {
  if (!Object.values(DeckBridgeParityAction).includes(input.action))
    throw new GraphQLError('Invalid parity action', {
      extensions: { code: 'INVALID_INPUT' },
    });
  if (input.action === DeckBridgeParityAction.START) {
    if (typeof input.correct !== 'boolean')
      throw new GraphQLError('START requires an explicit correct boolean', {
        extensions: { code: 'INVALID_INPUT' },
      });
    return { action: 'PARITY_START', correct: input.correct };
  }
  if (input.correct !== undefined)
    throw new GraphQLError('correct is only accepted for START', {
      extensions: { code: 'INVALID_INPUT' },
    });
  return { action: `PARITY_${input.action}` };
}
async function hostWrite(context: any, path: string, input: unknown) {
  const host = assertSupportedHost();
  if (host?.hostWriteSupported === false)
    throw new GraphQLError(
      'Host operations are outside the audited OS profile',
      { extensions: { code: 'HOST_COMPATIBILITY_UNVERIFIED' } },
    );
  const actor = principal(context),
    core = await callCore(actor, '/info');
  if (core.version !== bridgeVersion)
    throw new GraphQLError('Bridge deployment components do not match', {
      extensions: { code: 'CORE_VERSION_MISMATCH' },
    });
  return callCore(actor, path, input);
}

@Resolver(() => DeckBridgeSystemQueries)
export class DeckBridgeSystemQueriesResolver {
  @ResolveField(() => DeckBridgeSystemStatus)
  @UsePermissions({ resource: Resource.OS, action: AuthAction.READ_ANY })
  status(@Context() context: any) {
    return callCore(principal(context), '/system/status');
  }
}

@Resolver(() => DeckBridgeSystemMutations)
export class DeckBridgeSystemMutationsResolver {
  @ResolveField(() => DeckBridgeHostPlan)
  @UsePermissions({ resource: Resource.OS, action: AuthAction.UPDATE_ANY })
  prepare(
    @Args('input') input: DeckBridgeHostPreviewInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/system/preview', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.OS, action: AuthAction.UPDATE_ANY })
  shutdown(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/system/submit/shutdown', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.OS, action: AuthAction.UPDATE_ANY })
  reboot(@Args('input') input: DeckBridgeSubmitInput, @Context() context: any) {
    return hostWrite(context, '/system/submit/reboot', input);
  }
}

@Resolver(() => DeckBridgePluginQueries)
export class DeckBridgePluginQueriesResolver {
  @ResolveField(() => [DeckBridgePlugin])
  @UsePermissions({ resource: Resource.CONFIG, action: AuthAction.READ_ANY })
  installed(@Context() context: any) {
    return callCore(principal(context), '/plugins/status');
  }
}

@Resolver(() => DeckBridgePluginMutations)
export class DeckBridgePluginMutationsResolver {
  @ResolveField(() => DeckBridgeHostPlan)
  @UsePermissions({ resource: Resource.CONFIG, action: AuthAction.DELETE_ANY })
  prepareUninstall(
    @Args('pluginId') pluginId: string,
    @Context() context: any,
  ) {
    return hostWrite(context, '/plugins/preview', {
      action: 'UNINSTALL',
      target: pluginId,
    });
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.CONFIG, action: AuthAction.DELETE_ANY })
  uninstall(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/plugins/submit/uninstall', input);
  }
}

@Resolver(() => DeckBridgeArrayQueries)
export class DeckBridgeArrayQueriesResolver {
  @ResolveField(() => DeckBridgeArrayStatus)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.READ_ANY })
  status(@Context() context: any) {
    return callCore(principal(context), '/array/status');
  }
}

@Resolver(() => DeckBridgeArrayMutations)
export class DeckBridgeArrayMutationsResolver {
  @ResolveField(() => DeckBridgeHostPlan)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  prepare(
    @Args('input') input: DeckBridgeHostPreviewInput,
    @Context() context: any,
  ) {
    if (!['START', 'STOP'].includes(input.action))
      throw new GraphQLError('Invalid array action', {
        extensions: { code: 'INVALID_INPUT' },
      });
    return hostWrite(context, '/array/preview', input);
  }
  @ResolveField(() => DeckBridgeHostPlan)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  prepareParity(
    @Args('input') input: DeckBridgeParityPreviewInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/array/preview', parityPreview(input));
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  startParity(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/array/submit/parity_start', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  pauseParity(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/array/submit/parity_pause', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  resumeParity(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/array/submit/parity_resume', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  cancelParity(
    @Args('input') input: DeckBridgeSubmitInput,
    @Context() context: any,
  ) {
    return hostWrite(context, '/array/submit/parity_cancel', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  start(@Args('input') input: DeckBridgeSubmitInput, @Context() context: any) {
    return hostWrite(context, '/array/submit/start', input);
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.UPDATE_ANY })
  stop(@Args('input') input: DeckBridgeSubmitInput, @Context() context: any) {
    return hostWrite(context, '/array/submit/stop', input);
  }
}

@ObjectType()
export class DeckBridgeDockerOperations {}
@Resolver(() => DeckBridgeDockerOperations)
export class DeckBridgeDockerOperationsResolver {
  @ResolveField(() => DeckBridgeImageUpdateBatch)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  imageUpdateBatch(
    @Args('id') id: string,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset: number,
    @Args('limit', { type: () => Int, defaultValue: 100 }) limit: number,
    @Context() context: any,
  ) {
    return callUpdateCore(
      principal(context),
      `/docker/image-update-batches?id=${encodeURIComponent(id)}&${updatePage(offset, limit)}`,
    );
  }
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  get(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return callCore(
      principal(context),
      `/operations?domain=docker&id=${encodeURIComponent(id)}&after=${after}`,
    );
  }
  @ResolveField(() => DeckBridgeOperation, { nullable: true })
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  byRequestId(@Args('requestId') id: string, @Context() context: any) {
    return callCore(
      principal(context),
      `/operations/by-request?domain=docker&requestId=${encodeURIComponent(id)}`,
    );
  }
}

@Resolver()
export class DeckBridgeDockerEventsResolver {
  @Subscription(() => DeckBridgeUpdateCheckEvent, {
    resolve: (event: unknown) => event,
  })
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  deckBridgeDockerUpdateCheckEvents(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return coreUpdateEvents(
      principal(context),
      id,
      updateCursor(after),
      'checks',
    );
  }
  @Subscription(() => DeckBridgeImageUpdateBatchEvent, {
    resolve: (event: unknown) => event,
  })
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  deckBridgeDockerImageUpdateBatchEvents(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return coreUpdateEvents(
      principal(context),
      id,
      updateCursor(after),
      'batches',
    );
  }
  @Subscription(() => DeckBridgeEvent, { resolve: (event: unknown) => event })
  @UsePermissions({ resource: Resource.DOCKER, action: AuthAction.READ_ANY })
  deckBridgeDockerOperationEvents(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return coreEvents(principal(context), id, after, 'docker');
  }
}

@ObjectType()
export class DeckBridgeSystemOperations {}
@Resolver(() => DeckBridgeSystemOperations)
export class DeckBridgeSystemOperationsResolver {
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.OS, action: AuthAction.READ_ANY })
  get(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return callCore(
      principal(context),
      `/operations?domain=system&id=${encodeURIComponent(id)}&after=${after}`,
    );
  }
  @ResolveField(() => DeckBridgeOperation, { nullable: true })
  @UsePermissions({ resource: Resource.OS, action: AuthAction.READ_ANY })
  byRequestId(@Args('requestId') id: string, @Context() context: any) {
    return callCore(
      principal(context),
      `/operations/by-request?domain=system&requestId=${encodeURIComponent(id)}`,
    );
  }
}

@Resolver()
export class DeckBridgeSystemEventsResolver {
  @Subscription(() => DeckBridgeEvent, { resolve: (event: unknown) => event })
  @UsePermissions({ resource: Resource.OS, action: AuthAction.READ_ANY })
  deckBridgeSystemOperationEvents(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return coreEvents(principal(context), id, after, 'system');
  }
}

@ObjectType()
export class DeckBridgePluginOperations {}
@Resolver(() => DeckBridgePluginOperations)
export class DeckBridgePluginOperationsResolver {
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.CONFIG, action: AuthAction.READ_ANY })
  get(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return callCore(
      principal(context),
      `/operations?domain=plugins&id=${encodeURIComponent(id)}&after=${after}`,
    );
  }
  @ResolveField(() => DeckBridgeOperation, { nullable: true })
  @UsePermissions({ resource: Resource.CONFIG, action: AuthAction.READ_ANY })
  byRequestId(@Args('requestId') id: string, @Context() context: any) {
    return callCore(
      principal(context),
      `/operations/by-request?domain=plugins&requestId=${encodeURIComponent(id)}`,
    );
  }
}

@Resolver()
export class DeckBridgePluginEventsResolver {
  @Subscription(() => DeckBridgeEvent, { resolve: (event: unknown) => event })
  @UsePermissions({ resource: Resource.CONFIG, action: AuthAction.READ_ANY })
  deckBridgePluginOperationEvents(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return coreEvents(principal(context), id, after, 'plugins');
  }
}

@ObjectType()
export class DeckBridgeArrayOperations {}
@Resolver(() => DeckBridgeArrayOperations)
export class DeckBridgeArrayOperationsResolver {
  @ResolveField(() => DeckBridgeOperation)
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.READ_ANY })
  get(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return callCore(
      principal(context),
      `/operations?domain=array&id=${encodeURIComponent(id)}&after=${after}`,
    );
  }
  @ResolveField(() => DeckBridgeOperation, { nullable: true })
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.READ_ANY })
  byRequestId(@Args('requestId') id: string, @Context() context: any) {
    return callCore(
      principal(context),
      `/operations/by-request?domain=array&requestId=${encodeURIComponent(id)}`,
    );
  }
}

@Resolver()
export class DeckBridgeArrayEventsResolver {
  @Subscription(() => DeckBridgeEvent, { resolve: (event: unknown) => event })
  @UsePermissions({ resource: Resource.ARRAY, action: AuthAction.READ_ANY })
  deckBridgeArrayOperationEvents(
    @Args('id') id: string,
    @Args('after', { type: () => Int, defaultValue: 0 }) after: number,
    @Context() context: any,
  ) {
    return coreEvents(principal(context), id, after, 'array');
  }
}

export const resolvers = [
  DeckBridgeSystemQueriesResolver,
  DeckBridgeSystemMutationsResolver,
  DeckBridgePluginQueriesResolver,
  DeckBridgePluginMutationsResolver,
  DeckBridgeArrayQueriesResolver,
  DeckBridgeArrayMutationsResolver,
  DeckBridgeOperationResolver,
  DeckBridgeDockerOperationsResolver,
  DeckBridgeDockerEventsResolver,
  DeckBridgeSystemOperationsResolver,
  DeckBridgeSystemEventsResolver,
  DeckBridgePluginOperationsResolver,
  DeckBridgePluginEventsResolver,
  DeckBridgeArrayOperationsResolver,
  DeckBridgeArrayEventsResolver,
  DeckBridgeRootResolver,
  DeckBridgeQueriesResolver,
  DeckBridgeMutationsResolver,
  DeckBridgeDockerQueriesResolver,
  DeckBridgeDockerMutationsResolver,
  DeckBridgeOperationsResolver,
];
export const adapter = 'nestjs';
@Module({
  providers: [...resolvers, DeckBridgeService, DeckBridgeNamespaceGuard],
})
export class ApiModule {}
