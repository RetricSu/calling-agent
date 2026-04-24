use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_error::Error,
    ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*},
    context::Context,
};

const MAX_CYCLES: u64 = 10_000_000;

const ERR_INVALID_ARGS_LEN: i8 = 10;
const ERR_INVALID_GROUP_OUTPUT_COUNT: i8 = 12;
const ERR_LOCK_SCRIPT_CHANGED: i8 = 13;
const ERR_MISSING_URL: i8 = 15;

fn valid_registry_json() -> Bytes {
    Bytes::from(br#"{"url":"https://agent.example.com","price":"1 CKB"}"#.to_vec())
}

fn build_lock_script(context: &mut Context) -> Script {
    let always_success_out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());
    context
        .build_script(&always_success_out_point, Bytes::new())
        .expect("build always-success lock script")
}

fn build_type_script(context: &mut Context, args: Bytes) -> Script {
    let type_out_point = context.deploy_cell_by_name("service-registry");
    context
        .build_script(&type_out_point, args)
        .expect("build service-registry type script")
}

fn expect_script_error(err: Error, code: i8) {
    let message = err.to_string();
    assert!(
        message.contains(&format!("error code {}", code)),
        "expect error code {}, got: {}",
        code,
        message
    );
}

#[test]
fn test_create_registry_cell_success() {
    let mut context = Context::default();
    let lock_script = build_lock_script(&mut context);
    let type_script = build_type_script(&mut context, Bytes::from(vec![7u8; 32]));

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(300_00000000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(250_00000000u64)
                .lock(lock_script)
                .type_(Some(type_script).pack())
                .build(),
        )
        .output_data(valid_registry_json().pack())
        .build();

    let tx = context.complete_tx(tx);
    let cycles = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("registry create should pass");
    println!("consume cycles: {}", cycles);
}

#[test]
fn test_reject_data_without_url() {
    let mut context = Context::default();
    let lock_script = build_lock_script(&mut context);
    let type_script = build_type_script(&mut context, Bytes::from(vec![9u8; 32]));

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(200_00000000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );

    let invalid_data = Bytes::from(br#"{"price":"1 CKB","note":"registry"}"#.to_vec());

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(150_00000000u64)
                .lock(lock_script)
                .type_(Some(type_script).pack())
                .build(),
        )
        .output_data(invalid_data.pack())
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("missing url should be rejected");
    expect_script_error(err, ERR_MISSING_URL);
}

#[test]
fn test_reject_multiple_group_outputs() {
    let mut context = Context::default();
    let lock_script = build_lock_script(&mut context);
    let type_script = build_type_script(&mut context, Bytes::from(vec![1u8; 32]));

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(400_00000000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );

    let data = valid_registry_json();

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .build(),
        )
        .outputs(vec![
            CellOutput::new_builder()
                .capacity(120_00000000u64)
                .lock(lock_script.clone())
                .type_(Some(type_script.clone()).pack())
                .build(),
            CellOutput::new_builder()
                .capacity(120_00000000u64)
                .lock(lock_script)
                .type_(Some(type_script).pack())
                .build(),
        ])
        .outputs_data(vec![data.clone(), data].pack())
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("multiple group outputs should be rejected");
    expect_script_error(err, ERR_INVALID_GROUP_OUTPUT_COUNT);
}

#[test]
fn test_reject_lock_change_on_update() {
    let mut context = Context::default();
    let always_success_out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let lock_script = context
        .build_script(&always_success_out_point, Bytes::new())
        .expect("build lock script");
    let other_lock_script = context
        .build_script(&always_success_out_point, Bytes::from(vec![1u8]))
        .expect("build second lock script");
    let type_script = build_type_script(&mut context, Bytes::from(vec![3u8; 32]));

    let registry_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(160_00000000u64)
            .lock(lock_script)
            .type_(Some(type_script.clone()).pack())
            .build(),
        valid_registry_json(),
    );

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(registry_input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(150_00000000u64)
                .lock(other_lock_script)
                .type_(Some(type_script).pack())
                .build(),
        )
        .output_data(valid_registry_json().pack())
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("lock change must be rejected");
    expect_script_error(err, ERR_LOCK_SCRIPT_CHANGED);
}

#[test]
fn test_reject_non_type_id_args_len() {
    let mut context = Context::default();
    let lock_script = build_lock_script(&mut context);
    let type_script = build_type_script(&mut context, Bytes::from(vec![1u8; 16]));

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(180_00000000u64)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(150_00000000u64)
                .lock(lock_script)
                .type_(Some(type_script).pack())
                .build(),
        )
        .output_data(valid_registry_json().pack())
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("args not 32 bytes should be rejected");
    expect_script_error(err, ERR_INVALID_ARGS_LEN);
}
