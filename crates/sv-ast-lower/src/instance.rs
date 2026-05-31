use sv_parser::{RefNode, SyntaxTree, unwrap_node};
use crate::types::{InstanceNode, PortConnection, ParamOverride};
use crate::module::get_str;

pub fn lower_instances<M>(
    m: &M,
    tree: &SyntaxTree,
    _source: &str,
) -> Result<Vec<InstanceNode>, Box<dyn std::error::Error>>
where
    for<'a> &'a M: IntoIterator<Item = RefNode<'a>>,
{
    let mut instances = Vec::new();

    for node in m {
        if let RefNode::ModuleInstantiation(inst) = node {
            let mod_name_node = unwrap_node!(inst, ModuleIdentifier)
                .ok_or("missing ModuleIdentifier in instantiation")?;
            let module_name = get_str(tree, mod_name_node)?;

            let param_overrides = extract_param_overrides(inst, tree)?;

            for hi_node in inst {
                if let RefNode::HierarchicalInstance(hi) = hi_node {
                    let inst_name_node = unwrap_node!(hi, InstanceIdentifier)
                        .ok_or("missing InstanceIdentifier")?;
                    let instance_name = get_str(tree, inst_name_node)?;

                    let port_connections = extract_port_connections(hi, tree)?;

                    instances.push(InstanceNode {
                        module_name: module_name.clone(),
                        instance_name,
                        param_overrides: param_overrides.clone(),
                        port_connections,
                    });
                }
            }
        }
    }

    Ok(instances)
}

fn extract_port_connections(
    hi: &sv_parser::HierarchicalInstance,
    tree: &SyntaxTree,
) -> Result<Vec<PortConnection>, Box<dyn std::error::Error>> {
    let mut connections = Vec::new();

    for node in hi {
        if let RefNode::NamedPortConnectionIdentifier(conn) = node {
            let port_name_node = unwrap_node!(conn, PortIdentifier)
                .ok_or("missing PortIdentifier")?;
            let port_name = get_str(tree, port_name_node)?;

            // NamedPortConnectionIdentifier を DFS すると SimpleIdentifier が2つ現れる:
            //   1つ目 = PortIdentifier の内部識別子 (= port_name と同じ文字列)
            //   2つ目 = 接続信号名 (Expression 内の HierarchicalIdentifier 等)
            // なので2つ目を取る。
            let signal = {
                let mut count = 0usize;
                let mut found = None;
                for n in conn {
                    if let RefNode::SimpleIdentifier(_) = n {
                        count += 1;
                        if count == 2 {
                            found = get_str(tree, n).ok();
                            break;
                        }
                    }
                }
                found.unwrap_or_default()
            };

            connections.push(PortConnection { port_name, signal });
        }
    }

    Ok(connections)
}

fn extract_param_overrides(
    inst: &sv_parser::ModuleInstantiation,
    tree: &SyntaxTree,
) -> Result<Vec<ParamOverride>, Box<dyn std::error::Error>> {
    let mut overrides = Vec::new();

    for node in inst {
        if let RefNode::NamedParameterAssignment(p) = node {
            let param_node = unwrap_node!(p, ParameterIdentifier)
                .ok_or("missing ParameterIdentifier")?;
            let param_name = get_str(tree, param_node)?;

            // p.nodes = (Symbol('.'), ParameterIdentifier, Paren<Option<ParamExpression>>)
            // 整数リテラルの場合は IntegralNumber で直接取得できる。
            // 識別子値の場合は SimpleIdentifier が2つ現れる（1つ目=パラメータ名）ため
            // 2つ目を値として取る。
            let value = unwrap_node!(p, IntegralNumber)
                .and_then(|n| get_str(tree, n).ok())
                .unwrap_or_else(|| {
                    // パラメータ名のSimpleIdentifier(1つ目)を読み飛ばして2つ目を取る
                    let mut count = 0usize;
                    let mut found = None;
                    for n in p {
                        if let RefNode::SimpleIdentifier(_) = n {
                            count += 1;
                            if count == 2 {
                                found = get_str(tree, n).ok();
                                break;
                            }
                        }
                    }
                    found.unwrap_or_default()
                });

            overrides.push(ParamOverride { param_name, value });
        }
    }

    Ok(overrides)
}
