import getPackageName from './package-name';
import { join, dirname, resolve } from 'path';
import { NodePath } from '@babel/traverse';
import {
  blockStatement,
  callExpression,
  expressionStatement,
  functionExpression,
  identifier,
  importDeclaration,
  memberExpression,
  Program,
  returnStatement,
  stringLiteral,
  isStringLiteral,
  isArrayExpression,
  isFunction,
  CallExpression,
  StringLiteral,
  ArrayExpression,
  ExportNamedDeclaration,
  ImportDeclaration,
  ExportAllDeclaration,
  importNamespaceSpecifier,
} from '@babel/types';
import PackageCache from './package-cache';
import Package, { V2Package } from './package';
import { outputFileSync } from 'fs-extra';
import { Memoize } from 'typescript-memoize';
import { compile } from './js-handlebars';
import { explicitRelative } from './paths';

interface State {
  emberCLIVanillaJobs: Function[];
  adjustFile: AdjustFile;
  opts: {
    renamePackages: {
      [fromName: string]: string;
    };
    renameModules: {
      [fromName: string]: string;
    };
    extraImports: {
      absPath: string;
      target: string;
      runtimeName?: string;
    }[];
    externalsDir: string;
    activeAddons: {
      [packageName: string]: string;
    };
    relocatedFiles: { [relativePath: string]: string };
    resolvableExtensions: string[];
  };
}

export type Options = State['opts'];

const packageCache = PackageCache.shared('embroider-stage3');

type DefineExpressionPath = NodePath<CallExpression> & {
  node: CallExpression & {
    arguments: [StringLiteral, ArrayExpression, Function];
  };
};

export function isImportSyncExpression(path: NodePath<any>) {
  if (
    !path ||
    !path.isCallExpression() ||
    path.node.callee.type !== 'Identifier' ||
    !path.get('callee').referencesImport('@embroider/macros', 'importSync')
  ) {
    return false;
  }

  const args = path.node.arguments;
  return Array.isArray(args) && args.length === 1 && isStringLiteral(args[0]);
}

export function isDynamicImportExpression(path: NodePath<any>) {
  if (!path || !path.isCallExpression() || path.node.callee.type !== 'Import') {
    return false;
  }

  const args = path.node.arguments;
  return Array.isArray(args) && args.length === 1 && isStringLiteral(args[0]);
}

export function isDefineExpression(path: NodePath<any>): path is DefineExpressionPath {
  // should we allow nested defines, or stop at the top level?
  if (!path.isCallExpression() || path.node.callee.type !== 'Identifier' || path.node.callee.name !== 'define') {
    return false;
  }

  const args = path.node.arguments;

  // only match define with 3 arguments define(name: string, deps: string[], cb: Function);
  return (
    Array.isArray(args) &&
    args.length === 3 &&
    isStringLiteral(args[0]) &&
    isArrayExpression(args[1]) &&
    isFunction(args[2])
  );
}

function adjustSpecifier(specifier: string, file: AdjustFile, opts: Options, isDynamic: boolean) {
  if (specifier === '@embroider/macros') {
    // the macros package is always handled directly within babel (not
    // necessarily as a real resolvable package), so we should not mess with it.
    // It might not get compiled away until *after* our plugin has run, which is
    // why we need to know about it.
    return specifier;
  }

  specifier = handleRenaming(specifier, file, opts);
  specifier = handleExternal(specifier, file, opts, isDynamic);
  return specifier;
}

function handleRenaming(specifier: string, sourceFile: AdjustFile, opts: State['opts']) {
  let packageName = getPackageName(specifier);
  if (!packageName) {
    return specifier;
  }

  for (let [candidate, replacement] of Object.entries(opts.renameModules)) {
    if (candidate === specifier) {
      return replacement;
    }
    for (let extension of opts.resolvableExtensions) {
      if (candidate === specifier + '/index' + extension) {
        return replacement;
      }
      if (candidate === specifier + extension) {
        return replacement;
      }
    }
  }

  if (opts.renamePackages[packageName]) {
    return specifier.replace(packageName, opts.renamePackages[packageName]);
  }

  let pkg = sourceFile.owningPackage();
  if (!pkg || !pkg.isV2Ember()) {
    return specifier;
  }

  if (pkg.meta['auto-upgraded'] && pkg.name === packageName) {
    // we found a self-import, make it relative. Only auto-upgraded packages get
    // this help, v2 packages are natively supposed to use relative imports for
    // their own modules, and we want to push them all to do that correctly.
    let fullPath = specifier.replace(packageName, pkg.root);
    return explicitRelative(dirname(sourceFile.name), fullPath);
  }

  let relocatedIntoPkg = sourceFile.relocatedIntoPackage();
  if (relocatedIntoPkg && pkg.meta['auto-upgraded'] && relocatedIntoPkg.name === packageName) {
    // a file that was relocated into a package does a self-import of that
    // package's name. This can happen when an addon (like ember-cli-mirage)
    // emits files from its own treeForApp that contain imports of the app's own
    // fully qualified name.
    let fullPath = specifier.replace(packageName, relocatedIntoPkg.root);
    return explicitRelative(dirname(sourceFile.name), fullPath);
  }

  return specifier;
}

function isExplicitlyExternal(specifier: string, fromPkg: V2Package): boolean {
  return Boolean(fromPkg.isV2Addon() && fromPkg.meta['externals'] && fromPkg.meta['externals'].includes(specifier));
}

function isResolvable(packageName: string, fromPkg: Package): false | Package {
  try {
    let dep = packageCache.resolve(packageName, fromPkg);
    if (!dep.isEmberPackage() && !fromPkg.hasDependency('ember-auto-import')) {
      return false;
    }
    return dep;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
    return false;
  }
}

const dynamicMissingModule = compile(`
  throw new Error('Could not find module \`{{{js-string-escape moduleName}}}\`');
`) as (params: { moduleName: string }) => string;

const externalTemplate = compile(`
{{#if (eq runtimeName "require")}}
const m = window.requirejs;
{{else}}
const m = window.require("{{{js-string-escape runtimeName}}}");
{{/if}}
{{!-
  There are plenty of hand-written AMD defines floating around
  that lack this, and they will break when other build systems
  encounter them.

  As far as I can tell, Ember's loader was already treating this
  case as a module, so in theory we aren't breaking anything by
  marking it as such when other packagers come looking.

  todo: get review on this part.
-}}
if (m.default && !m.__esModule) {
  m.__esModule = true;
}
module.exports = m;
`) as (params: { runtimeName: string }) => string;

function handleExternal(specifier: string, sourceFile: AdjustFile, opts: Options, isDynamic: boolean): string {
  let pkg = sourceFile.owningPackage();
  if (!pkg || !pkg.isV2Ember()) {
    return specifier;
  }

  let packageName = getPackageName(specifier);
  if (!packageName) {
    // This is a relative import. We don't automatically externalize those
    // because it's rare, and by keeping them static we give better errors. But
    // we do allow them to be explicitly externalized by the package author (or
    // a compat adapter). In the metadata, they would be listed in
    // package-relative form, so we need to convert this specifier to that.
    let absoluteSpecifier = resolve(dirname(sourceFile.name), specifier);
    let packageRelativeSpecifier = explicitRelative(pkg.root, absoluteSpecifier);
    if (isExplicitlyExternal(packageRelativeSpecifier, pkg)) {
      let publicSpecifier = absoluteSpecifier.replace(pkg.root, pkg.name);
      return makeExternal(publicSpecifier, sourceFile, opts);
    } else {
      return specifier;
    }
  }

  // absolute package imports can also be explicitly external based on their
  // full specifier name
  if (isExplicitlyExternal(specifier, pkg)) {
    return makeExternal(specifier, sourceFile, opts);
  }

  let relocatedPkg = sourceFile.relocatedIntoPackage();
  if (relocatedPkg) {
    // this file has been moved into another package (presumably the app).

    // self-imports are legal in the app tree, even for v2 packages
    if (packageName === pkg.name) {
      return specifier;
    }

    // first try to resolve from the destination package
    if (isResolvable(packageName, relocatedPkg)) {
      if (!pkg.meta['auto-upgraded']) {
        throw new Error(
          `${pkg.name} is trying to import ${packageName} from within its app tree. This is unsafe, because ${pkg.name} can't control which dependencies are resolvable from the app`
        );
      }
      return specifier;
    } else {
      // second try to resolve from the source package
      let targetPkg = isResolvable(packageName, pkg);
      if (targetPkg) {
        if (!pkg.meta['auto-upgraded']) {
          throw new Error(
            `${pkg.name} is trying to import ${packageName} from within its app tree. This is unsafe, because ${pkg.name} can't control which dependencies are resolvable from the app`
          );
        }
        // we found it, but we need to rewrite it because it's not really going to
        // resolve from where its sitting
        return explicitRelative(dirname(sourceFile.name), specifier.replace(packageName, targetPkg.root));
      }
    }
  } else {
    if (isResolvable(packageName, pkg)) {
      if (!pkg.meta['auto-upgraded'] && !pkg.hasDependency(packageName)) {
        throw new Error(
          `${pkg.name} is trying to import from ${packageName} but that is not one of its explicit dependencies`
        );
      }
      return specifier;
    }
  }

  // auto-upgraded packages can fall back to the set of known active addons
  if (pkg.meta['auto-upgraded'] && opts.activeAddons[packageName]) {
    return explicitRelative(dirname(sourceFile.name), specifier.replace(packageName, opts.activeAddons[packageName]));
  }

  // auto-upgraded packages can fall back to attmpeting to find dependencies at
  // runtime. Native v2 packages can only get this behavior in the
  // isExplicitlyExternal case above because they need to explicitly ask for
  // externals.
  if (pkg.meta['auto-upgraded']) {
    return makeExternal(specifier, sourceFile, opts);
  }

  // non-resolvable imports in dynamic positions become runtime errors, not
  // build-time errors, so we emit the runtime error module here before the
  // stage3 packager has a chance to see the missing module. (Maybe some stage3
  // packagers will have this behavior by default, because it would make sense,
  // but webpack at least does not.)
  if (isDynamic) {
    return makeMissingModule(specifier, sourceFile, opts);
  }

  // this is falling through with the original specifier which was
  // non-resolvable, which will presumably cause a static build error in stage3.
  return specifier;
}

function makeMissingModule(specifier: string, sourceFile: AdjustFile, opts: Options): string {
  let target = join(opts.externalsDir, specifier + '.js');
  outputFileSync(
    target,
    dynamicMissingModule({
      moduleName: specifier,
    })
  );
  return explicitRelative(dirname(sourceFile.name), target.slice(0, -3));
}

function makeExternal(specifier: string, sourceFile: AdjustFile, opts: Options): string {
  let target = join(opts.externalsDir, specifier + '.js');
  outputFileSync(
    target,
    externalTemplate({
      runtimeName: specifier,
    })
  );
  return explicitRelative(dirname(sourceFile.name), target.slice(0, -3));
}

export default function main() {
  return {
    visitor: {
      Program: {
        enter(path: NodePath<Program>, state: State) {
          state.emberCLIVanillaJobs = [];
          state.adjustFile = new AdjustFile(path.hub.file.opts.filename, state.opts.relocatedFiles);
          addExtraImports(path, state.opts.extraImports);
        },
        exit(_: any, state: State) {
          state.emberCLIVanillaJobs.forEach(job => job());
        },
      },
      CallExpression(path: NodePath<CallExpression>, state: State) {
        if (isImportSyncExpression(path) || isDynamicImportExpression(path)) {
          const [source] = path.get('arguments');
          let { opts } = state;
          let specifier = adjustSpecifier((source.node as any).value, state.adjustFile, opts, true);
          source.replaceWith(stringLiteral(specifier));
          return;
        }

        // Should/can we make this early exit when the first define was found?
        if (!isDefineExpression(path)) {
          return;
        }

        let pkg = state.adjustFile.owningPackage();
        if (pkg && pkg.isV2Ember() && !pkg.meta['auto-upgraded']) {
          throw new Error(
            `The file ${state.adjustFile.originalFile} in package ${pkg.name} tried to use AMD define. Native V2 Ember addons are forbidden from using AMD define, they must use ECMA export only.`
          );
        }

        let { opts } = state;

        const dependencies = path.node.arguments[1];

        const specifiers = dependencies.elements.slice();
        specifiers.push(path.node.arguments[0]);

        for (let source of specifiers) {
          if (!source) {
            continue;
          }

          if (source.type !== 'StringLiteral') {
            throw path.buildCodeFrameError(`expected only string literal arguments`);
          }

          if (source.value === 'exports' || source.value === 'require') {
            // skip "special" AMD dependencies
            continue;
          }

          let specifier = adjustSpecifier(source.value, state.adjustFile, opts, false);

          if (specifier !== source.value) {
            source.value = specifier;
          }
        }
      },
      'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(
        path: NodePath<ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration>,
        state: State
      ) {
        let { opts, emberCLIVanillaJobs } = state;
        const { source } = path.node;
        if (source === null || source === undefined) {
          return;
        }

        let specifier = adjustSpecifier(source.value, state.adjustFile, opts, false);
        if (specifier !== source.value) {
          emberCLIVanillaJobs.push(() => (source.value = specifier));
        }
      },
    },
  };
}

(main as any).baseDir = function () {
  return join(__dirname, '..');
};

function addExtraImports(path: NodePath<Program>, extraImports: Required<State['opts']>['extraImports']) {
  let counter = 0;
  for (let { absPath, target, runtimeName } of extraImports) {
    if (absPath === path.hub.file.opts.filename) {
      if (runtimeName) {
        path.node.body.unshift(amdDefine(runtimeName, counter));
        path.node.body.unshift(
          importDeclaration([importNamespaceSpecifier(identifier(`a${counter++}`))], stringLiteral(target))
        );
      } else {
        path.node.body.unshift(importDeclaration([], stringLiteral(target)));
      }
    }
  }
}

function amdDefine(runtimeName: string, importCounter: number) {
  return expressionStatement(
    callExpression(memberExpression(identifier('window'), identifier('define')), [
      stringLiteral(runtimeName),
      functionExpression(null, [], blockStatement([returnStatement(identifier(`a${importCounter}`))])),
    ])
  );
}

class AdjustFile {
  readonly originalFile: string;

  constructor(public name: string, relocatedFiles: Options['relocatedFiles']) {
    this.originalFile = relocatedFiles[name] || name;
  }

  get isRelocated() {
    return this.originalFile !== this.name;
  }

  @Memoize()
  owningPackage(): Package | undefined {
    return packageCache.ownerOfFile(this.originalFile);
  }

  @Memoize()
  relocatedIntoPackage(): Package | undefined {
    if (this.isRelocated) {
      return packageCache.ownerOfFile(this.name);
    }
  }
}
