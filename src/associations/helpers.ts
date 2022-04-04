import isUndefined from 'lodash/isUndefined';
import lowerFirst from 'lodash/lowerFirst';
import omitBy from 'lodash/omitBy';
import type { Class } from 'type-fest';
import { AssociationError } from '../errors/index.js';
import type { Model, ModelAttributeColumnOptions, ModelStatic } from '../model';
import { isModelStatic } from '../model';
import type { Sequelize } from '../sequelize';
import * as deprecations from '../utils/deprecations.js';
import { cloneDeep } from '../utils/index.js';
import type { Association, AssociationOptions, NormalizedAssociationOptions } from './base';

export function checkNamingCollision(source: ModelStatic<any>, associationName: string): void {
  if (Object.prototype.hasOwnProperty.call(source.getAttributes(), associationName)) {
    throw new Error(
      `Naming collision between attribute '${associationName}'`
      + ` and association '${associationName}' on model ${source.name}`
      + '. To remedy this, change the "as" options in your association definition',
    );
  }
}

export function addForeignKeyConstraints(
  newAttribute: ModelAttributeColumnOptions,
  source: ModelStatic<Model>,
  options: AssociationOptions<string>,
  key: string,
): void {
  // FK constraints are opt-in: users must either set `foreignKeyConstraints`
  // on the association, or request an `onDelete` or `onUpdate` behavior

  if (options.foreignKeyConstraint || options.onDelete || options.onUpdate) {
    // Find primary keys: composite keys not supported with this approach
    const primaryKeys = Object.keys(source.primaryKeys)
      .map(primaryKeyAttribute => source.getAttributes()[primaryKeyAttribute].field || primaryKeyAttribute);

    if (primaryKeys.length === 1 || !primaryKeys.includes(key)) {
      newAttribute.references = {
        model: source.getTableName(),
        key: key || primaryKeys[0],
      };

      newAttribute.onDelete = options.onDelete;
      newAttribute.onUpdate = options.onUpdate;
    }
  }
}

/**
 * Mixin (inject) association methods to model prototype
 *
 * @private
 *
 * @param association instance
 * @param mixinTargetPrototype Model prototype
 * @param methods Method names to inject
 * @param aliases Mapping between model and association method names
 *
 */
export function mixinMethods<A extends Association, Aliases extends Record<string, string>>(
  association: A,
  mixinTargetPrototype: Model,
  methods: Array<keyof A | keyof Aliases>,
  aliases?: Aliases,
): void {
  for (const method of methods) {
    // @ts-expect-error
    const targetMethodName = association.accessors[method];

    // don't override custom methods
    if (Object.prototype.hasOwnProperty.call(mixinTargetPrototype, targetMethodName)) {
      continue;
    }

    // @ts-expect-error
    const realMethod = aliases?.[method] || method;

    Object.defineProperty(mixinTargetPrototype, targetMethodName, {
      enumerable: false,
      value(...params: any[]) {
        // @ts-expect-error
        return association[realMethod](this, ...params);
      },
    });
  }
}

/**
 * Used to prevent users from instantiating Associations themselves.
 * Instantiating associations is not safe as it mutates the Model object.
 *
 * @internal
 * @private do not expose outside sequelize
 */
export const AssociationConstructorSecret = Symbol('AssociationConstructorPrivateKey');

export function getModel<M extends Model>(
  sequelize: Sequelize,
  model: string | ModelStatic<M>,
): ModelStatic<M> | null {
  if (typeof model === 'string') {
    if (!sequelize.isDefined(model)) {
      return null;
    }

    return sequelize.model(model) as ModelStatic<M>;
  }

  return model;
}

export function removeUndefined<T>(val: T): T {
  return omitBy(val, isUndefined) as T;
}

export function assertAssociationUnique(source: ModelStatic<any>, options: NormalizedAssociationOptions<any>) {
  const as = options.as;

  const existingAssociation = source.associations[as];
  if (!existingAssociation) {
    return;
  }

  const createdByRoot = existingAssociation.rootAssociation;

  // TODO: if this association was created by another, and their options are identical, don't throw. Ignore the creation of this association instead.
  throw new AssociationError(
    createdByRoot === existingAssociation
      ? `You have defined two associations with the same name "${as}" on the model "${source.name}". Use another alias using the "as" parameter.`
      : `You are trying to define the association "${as}" on the model "${source.name}", but that association was already created by ${createdByRoot.source.name}.${createdByRoot.associationType}(${createdByRoot.target.name})`,
  );
}

export function assertAssociationModelIsDefined(model: ModelStatic<any>): void {
  if (!model.sequelize) {
    throw new Error(`Model ${model.name} must be defined (through Model.init or Sequelize#define) before calling one of its association declaration methods.`);
  }
}

export function defineAssociation<T extends Association, O extends AssociationOptions<any>>(
  type: Class<T>,
  source: ModelStatic<Model>,
  target: ModelStatic<Model>,
  options: O,
  callback: (opts: O) => T,
): T {
  if (!isModelStatic(target)) {
    throw new Error(`${source.name}.${lowerFirst(type.name)} called with something that's not a subclass of Sequelize.Model`);
  }

  assertAssociationModelIsDefined(source);
  assertAssociationModelIsDefined(target);

  options = cloneDeep(options);

  const sequelize = source.sequelize!;
  Object.defineProperty(options, 'sequelize', {
    configurable: true,
    get() {
      deprecations.movedSequelizeParam();

      return sequelize;
    },
  });

  options.hooks = Boolean(options.hooks ?? false);

  if (options.hooks) {
    source.runHooks('beforeAssociate', { source, target, type, sequelize }, options);
  }

  // the id is in the foreign table
  const association = callback(options);

  if (options.hooks) {
    source.runHooks('afterAssociate', { source, target, type, association, sequelize }, options);
  }

  return association;
}
